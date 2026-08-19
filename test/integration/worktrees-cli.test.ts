/**
 * `pifleet worktrees` (SRD §9.2/§10): the operator-visibility replacement for
 * `git worktree list`, now that a worker checkout is an independent clone
 * rather than an entry in the parent's `.git/worktrees/`.
 *
 * Driven as the real CLI, the same way `down-prune.test.ts` drives `down` —
 * a flag or a report that only ever runs inside `bun test` is not proven to
 * work from a shell. Checkouts are made by the real `createWorkerWorktrees`,
 * because what is under test is whether this command can describe what `up`
 * actually creates.
 *
 * Every repository is SYNTHETIC (`test/fixtures/synthetic-repo.ts`). Nothing
 * clones from this project's own repository — see that module's header for
 * the pack file that rule cost.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";
import { runPaths } from "../../src/run/paths.ts";
import { createWorkerWorktrees, type WorkerWorktree } from "../../src/run/worktree.ts";
import { parseConfig } from "../../src/config/load.ts";
import { gitOk, seedGitRepo } from "../fixtures/synthetic-repo.ts";

const CLI = join(new URL("../../", import.meta.url).pathname, "src/cli/index.ts");

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

interface Rig {
  root: string;
  runId: string;
  repo: string;
  worktrees: WorkerWorktree[];
}

async function makeRig(opts: { workers?: string[] } = {}): Promise<Rig> {
  const workers = opts.workers ?? ["eng-1"];
  const base = await mkdtemp(join(tmpdir(), "pifleet-worktrees-cli-"));
  bases.push(base);
  const root = join(base, "runs");
  const repo = join(base, "repo");
  const runId = "2026-08-18T00-00-00Z-wtls";
  await seedGitRepo(repo);

  const yaml = [
    "version: 2",
    "name: worktrees-cli-test",
    'docker: {pi_version: "0.79.6", network: wtls-net}',
    `run: {repo: ${repo}, budget: {tokens_ceiling: 1000000}}`,
    "llm: {model: wtls-model}",
    "roles:",
    "  engineer: {}",
    "workers:",
    ...workers.map((w) => `  - {id: ${w}, role: engineer}`),
    "",
  ].join("\n");
  const configPath = join(base, "fleet.yaml");
  const loaded = await parseConfig(yaml, configPath);

  const run = runPaths(runId, root);
  await mkdir(run.workersDir, { recursive: true });
  const worktrees = await createWorkerWorktrees({ loaded, run, repo, workerIds: workers });

  await writeFile(
    run.runJson,
    JSON.stringify({ schema: "pifleet.run/v1", run_id: runId, repo, worktrees }),
    "utf8",
  );
  return { root, runId, repo, worktrees };
}

async function worktreesList(
  rig: { root: string; runId?: string },
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const runArgs = rig.runId === undefined ? [] : ["--run", rig.runId];
  const p = Bun.spawn([process.execPath, CLI, "worktrees", ...runArgs, ...args], {
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

describe("pifleet worktrees", () => {
  test("lists a freshly created checkout as clean, with branch, path and base sha", async () => {
    const rig = await makeRig();
    const wt = rig.worktrees[0]!;

    const r = await worktreesList(rig, ["--json"]);
    expect(r.code, `stderr: ${r.stderr.slice(0, 400)}`).toBe(EXIT.SUCCESS);
    const out = parse(r.stdout);
    expect(out["repo"]).toBe(rig.repo);
    expect(out["worktrees"]).toEqual([
      {
        worker_id: "eng-1",
        branch: wt.branch,
        path: wt.path,
        base_sha: wt.baseSha,
        remote_name: wt.remoteName,
        present: true,
        dirty: false,
        status_lines: 0,
        commits_ahead: 0,
        unreadable: null,
      },
    ]);

    // The human-readable form names the same facts, unabbreviated for the path.
    const plain = await worktreesList(rig);
    expect(plain.stdout).toContain(wt.branch);
    expect(plain.stdout).toContain(wt.path);
    expect(plain.stdout).toContain("clean");
  });

  test("an uncommitted edit is reported dirty, with counts", async () => {
    const rig = await makeRig();
    const wt = rig.worktrees[0]!;
    await writeFile(join(wt.path, "unsaved.txt"), "a worker's only copy\n");

    const r = await worktreesList(rig, ["--json"]);
    const out = parse(r.stdout);
    const rows = out["worktrees"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ present: true, dirty: true, status_lines: 1 });

    const plain = await worktreesList(rig);
    expect(plain.stdout).toContain("dirty");
    expect(plain.stdout).toContain("1 uncommitted path(s)");
  });

  test("a commit past baseSha is dirty via commits_ahead, even with a clean working tree", async () => {
    const rig = await makeRig();
    const wt = rig.worktrees[0]!;
    await writeFile(join(wt.path, "committed.txt"), "worker output\n");
    await gitOk(wt.path, "add", "-A");
    await gitOk(wt.path, "commit", "-q", "-m", "worker commit");

    const r = await worktreesList(rig, ["--json"]);
    const rows = parse(r.stdout)["worktrees"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ present: true, dirty: true, status_lines: 0, commits_ahead: 1 });
  });

  test("a checkout removed from disk (e.g. by hand, or a prior --prune) is MISSING, not silently absent", async () => {
    const rig = await makeRig();
    const wt = rig.worktrees[0]!;
    await rm(wt.path, { recursive: true, force: true });

    const r = await worktreesList(rig, ["--json"]);
    expect(r.code).toBe(EXIT.SUCCESS);
    const rows = parse(r.stdout)["worktrees"] as Array<Record<string, unknown>>;
    expect(rows[0]).toMatchObject({ present: false, dirty: null });

    const plain = await worktreesList(rig);
    expect(plain.stdout).toContain("MISSING");
  });

  test("multiple workers are listed sorted by worker id, independent of creation order", async () => {
    const rig = await makeRig({ workers: ["eng-2", "eng-1"] });
    const r = await worktreesList(rig, ["--json"]);
    const rows = parse(r.stdout)["worktrees"] as Array<Record<string, unknown>>;
    expect(rows.map((row) => row["worker_id"])).toEqual(["eng-1", "eng-2"]);
  });

  test("a run that recorded no checkouts reports an empty list, not an error", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-worktrees-cli-none-"));
    bases.push(base);
    const root = join(base, "runs");
    const runId = "2026-08-18T00-00-00Z-none";
    const run = runPaths(runId, root);
    await mkdir(run.workersDir, { recursive: true });
    await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }), "utf8");

    const r = await worktreesList({ root, runId }, ["--json"]);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(parse(r.stdout)).toMatchObject({ worktrees: [] });

    const plain = await worktreesList({ root, runId });
    expect(plain.stdout).toContain("no per-worker checkouts recorded");
  });

  test("no runs at all is a usage error, like every other run-scoped command", async () => {
    const base = await mkdtemp(join(tmpdir(), "pifleet-worktrees-cli-empty-"));
    bases.push(base);
    const root = join(base, "runs");
    await mkdir(root, { recursive: true });

    const r = await worktreesList({ root });
    expect(r.code).toBe(EXIT.USAGE);
    expect(r.stderr).toContain("no runs found");
  });

  test("with no --run, resolves the latest run id — the same default every other command uses", async () => {
    const rig = await makeRig();
    const r = await worktreesList({ root: rig.root }, ["--json"]);
    expect(r.code).toBe(EXIT.SUCCESS);
    expect(parse(r.stdout)["run_id"]).toBe(rig.runId);
  });
});
