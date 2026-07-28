/**
 * RunReport collection from a synthetic run directory (SRD §10, §14.2).
 *
 * The run dir is assembled by hand — inbox envelopes, outbox result
 * envelopes, task records, ledger shards, a scheduler snapshot — against a
 * REAL repository, because the property under test is the §8.2 primacy rule
 * as it surfaces in the report: a worker's self-report may downgrade a
 * verdict and must never upgrade one, no matter which file it arrives
 * through. The laundering test (a scheduler snapshot claiming `success` for
 * a task whose diff is empty) is the one that pins the second door shut.
 */

import { beforeAll, afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RunReportSchema } from "../../src/contracts.ts";
import { runPaths } from "../../src/run/paths.ts";
import { collectRunReport } from "../../src/report/collect.ts";
import type { MergeCheckInput } from "../../src/report/merge.ts";

const RUN_ID = "2026-07-27T00-00-00Z-rprt";

let tmp: string;
let repo: string;
let wtGood: string;
let wtEmpty: string;
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
    brief: "collect fixture",
    repo,
    host_workdir: workdir,
    container_workdir: "/workspace",
    branch: `fleet/${RUN_ID}/${worker}`,
    base_ref: baseSha,
    outbox: `/outbox/${taskId}`,
    deadline_s: 1500,
  };
}

async function result(worker: string, taskId: string, body: Record<string, unknown>): Promise<void> {
  await mkdir(join(runDir, "outbox", worker, taskId), { recursive: true });
  await writeFile(
    join(runDir, "outbox", worker, taskId, "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: taskId,
      epoch: 1,
      worker,
      ...body,
    }),
  );
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pifleet-collect-"));
  repo = join(tmp, "repo");
  wtGood = join(tmp, "wt-good");
  wtEmpty = join(tmp, "wt-empty");
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

  // w1: one real commit of real work.
  await git(repo, "worktree", "add", "-q", "-b", `fleet/${RUN_ID}/w1`, wtGood, baseSha);
  await writeFile(join(wtGood, "f.txt"), "one\nCHANGED\n");
  await git(wtGood, "commit", "-qam", "w1 edit");

  // w2: a worktree with NO commits — the empty-diff liar's stage.
  await git(repo, "worktree", "add", "-q", "-b", `fleet/${RUN_ID}/w2`, wtEmpty, baseSha);

  await mkdir(join(runDir, "inbox"), { recursive: true });
  await writeFile(join(runDir, "run.json"), JSON.stringify({ run_id: RUN_ID }));

  // T-good: honest — the claim matches the diff, and the supervisor settled it.
  await writeFile(join(runDir, "inbox", "T-good.json"), JSON.stringify(envelope("T-good", "w1", wtGood)));
  await result("w1", "T-good", {
    status: "success",
    files_changed: [{ path: "f.txt", change: "modified" }],
  });
  await mkdir(join(runDir, "workers", "w1", "tasks"), { recursive: true });
  await writeFile(
    join(runDir, "workers", "w1", "tasks", "T-good.json"),
    JSON.stringify({
      schema: "pifleet.taskrecord/v1",
      task_id: "T-good",
      attempt_id: "T-good#1",
      worker: "w1",
      run_id: RUN_ID,
      epoch: 1,
      verdict: "success",
      settled_at: new Date().toISOString(),
    }),
  );
  // w1 is still mid-flight from the fleet's point of view.
  await writeFile(
    join(runDir, "workers", "w1", "state.json"),
    JSON.stringify({
      schema: "pifleet.state/v1",
      worker: "w1",
      run_id: RUN_ID,
      pid: 4242,
      pgid: 4242,
      started_at: new Date().toISOString(),
      phase: "busy",
      epoch: 1,
    }),
  );

  // T-lie: claims success over an EMPTY diff. The verdict must come out
  // `failed` however many files repeat the claim.
  await writeFile(join(runDir, "inbox", "T-lie.json"), JSON.stringify(envelope("T-lie", "w2", wtEmpty)));
  await result("w2", "T-lie", { status: "success", summary: "definitely did lots of work" });

  // T-down: real diff, worker itself says only `partial` — the claim may
  // LOWER what the evidence alone could not decide.
  await writeFile(join(runDir, "inbox", "T-down.json"), JSON.stringify(envelope("T-down", "w1", wtGood)));
  await result("w1", "T-down", {
    status: "partial",
    files_changed: [{ path: "f.txt", change: "modified" }],
  });

  // T-nowhere: dispatched with no worktree at all — harvest degrades, the
  // report row survives.
  await writeFile(
    join(runDir, "inbox", "T-nowhere.json"),
    JSON.stringify({ ...envelope("T-nowhere", "w3", "unset"), repo: "unset" }),
  );

  // T-corrupt: the inbox envelope itself is garbage.
  await writeFile(join(runDir, "inbox", "T-corrupt.json"), "{not json");

  // The ledger: a dispatch the inbox has no envelope for (T-ghost), plus a
  // corrupt line that must become a note, not a lost report.
  await mkdir(join(runDir, "ledger"), { recursive: true });
  const led = (event: string, task: string): string =>
    `${JSON.stringify({ seq: 0, ts: new Date().toISOString(), actor: "cli-dispatch-1", run_id: RUN_ID, event, task_id: task })}\n`;
  await writeFile(
    join(runDir, "ledger", "cli-dispatch-1.jsonl"),
    led("dispatched", "T-good") + led("dispatched", "T-ghost") + "{torn record\n",
  );

  // The scheduler's snapshot: undispatched rows the inbox cannot know about,
  // and a verdict for T-lie it must not be allowed to donate.
  await writeFile(
    join(runDir, "schedule.json"),
    JSON.stringify({
      schema: "pifleet.schedule/v1",
      tasks: [
        { id: "t-lie", state: "dispatched", worker: "w2", task_id: "T-lie", verdict: "success" },
        { id: "t-blocked", state: "blocked", blocked_by: "t-lie", verdict: "success" },
        { id: "t-waiting", state: "waiting", depends_on: ["t-blocked"] },
        "not an object",
      ],
    }),
  );
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

/** Collect with the merge pre-check stubbed out; merge has its own suite. */
async function collect(): Promise<Awaited<ReturnType<typeof collectRunReport>>> {
  return collectRunReport(runPaths(RUN_ID, runsDir), { precheck: async () => [] });
}

describe("collectRunReport — verdicts are derived, never donated", () => {
  // Would fail if the report started trusting the result envelope: the ONLY
  // path to `failed` here is adjudication of the empty diff against the claim.
  test("a claimed success over an empty diff reports failed", async () => {
    const { report } = await collect();
    const row = report.schedule.find((r) => r.task_id === "T-lie");
    expect(row?.verdict).toBe("failed");
  });

  /**
   * The laundering guard. The scheduler snapshot ALSO says `success` for
   * T-lie; would fail if a snapshot verdict could bypass adjudication by
   * arriving through schedule.json instead of result.json.
   */
  test("a snapshot verdict cannot upgrade what the harvest derived", async () => {
    const { report } = await collect();
    const row = report.schedule.find((r) => r.id === "t-lie");
    expect(row).toBeDefined();
    expect(row!.verdict).toBe("failed");
  });

  // Would fail if the downgrade direction were also blocked — the asymmetry
  // is the rule: claims may lower, never raise (§7.2).
  test("a worker's own partial stands over a real diff", async () => {
    const { report } = await collect();
    expect(report.schedule.find((r) => r.task_id === "T-down")?.verdict).toBe("partial");
  });

  test("an honest claim over a matching diff reports success", async () => {
    const { report } = await collect();
    expect(report.schedule.find((r) => r.task_id === "T-good")?.verdict).toBe("success");
  });

  // Would fail if an undispatched row kept a snapshot-claimed verdict: a task
  // that never ran has nothing to grade.
  test("undispatched snapshot rows keep their state and lose any verdict", async () => {
    const { report } = await collect();
    const blocked = report.schedule.find((r) => r.id === "t-blocked");
    expect(blocked?.state).toBe("blocked");
    expect(blocked?.verdict).toBeNull();
    expect(blocked?.blocked_by).toBe("t-lie");
    expect(report.schedule.find((r) => r.id === "t-waiting")?.state).toBe("waiting");
  });
});

describe("collectRunReport — degraded inputs still produce a report", () => {
  // Would fail if any single bad file crashed collection; every degradation
  // must surface as a note plus a row, not an exception.
  test("corrupt inbox, ghost dispatch and missing worktree each yield a row and a note", async () => {
    const { report, notes } = await collect();
    const ids = report.schedule.map((r) => r.id);
    expect(ids).toContain("T-corrupt");
    expect(ids).toContain("T-ghost");
    expect(ids).toContain("T-nowhere");
    expect(report.schedule.find((r) => r.id === "T-corrupt")?.verdict).toBe("unknown");
    expect(report.schedule.find((r) => r.id === "T-ghost")?.verdict).toBe("unknown");
    expect(notes.some((n) => n.includes("T-corrupt.json"))).toBe(true);
    expect(notes.some((n) => n.includes("T-ghost"))).toBe(true);
    expect(notes.some((n) => n.startsWith("ledger:"))).toBe(true);
    expect(notes.some((n) => n.includes("schedule.json entry 3"))).toBe(true);
  });

  // Would fail if the settle marker came from anywhere but the supervisor's
  // task record: only T-good has one, so only T-good may be `done`.
  test("done is the supervisor's word: settled tasks are done, the rest stay dispatched", async () => {
    const { report } = await collect();
    expect(report.schedule.find((r) => r.task_id === "T-good")?.state).toBe("done");
    expect(report.schedule.find((r) => r.task_id === "T-lie")?.state).toBe("dispatched");
  });

  test("a live worker is noted so the reader knows the rows may still move", async () => {
    const { notes } = await collect();
    expect(notes.some((n) => n.includes("worker w1 was busy"))).toBe(true);
  });

  // Would fail if totals drifted from the schedule they summarize.
  test("totals are computed from the final schedule", async () => {
    const { report } = await collect();
    expect(report.totals.tasks).toBe(report.schedule.length);
    expect(report.totals.done).toBe(1); // T-good
    expect(report.totals.blocked).toBe(1); // t-blocked
    expect(report.totals.failed).toBe(1); // T-lie
    RunReportSchema.parse(report);
  });

  // Requirement: a run with NOTHING in it reports, it does not crash.
  test("an empty run directory produces an empty report", async () => {
    const emptyId = "2026-07-27T00-00-01Z-mpty";
    await mkdir(join(runsDir, emptyId), { recursive: true });
    await writeFile(join(runsDir, emptyId, "run.json"), JSON.stringify({ run_id: emptyId }));
    const { report, notes } = await collectRunReport(runPaths(emptyId, runsDir), {
      precheck: async () => [],
    });
    expect(report.schedule).toEqual([]);
    expect(report.merge).toEqual([]);
    expect(report.totals.tasks).toBe(0);
    expect(notes).toEqual([]);
  });
});

describe("collectRunReport — merge pre-check wiring", () => {
  // Would fail if the pre-check stopped receiving one deduped entry per
  // (worker, branch): w1 has two tasks on one branch and must be checked once.
  test("inputs are deduped per worker branch and carry the envelope's facts", async () => {
    let seen: readonly MergeCheckInput[] = [];
    await collectRunReport(runPaths(RUN_ID, runsDir), {
      precheck: async (inputs) => {
        seen = inputs;
        return [];
      },
    });
    const w1 = seen.filter((i) => i.worker === "w1");
    expect(w1).toHaveLength(1);
    expect(w1[0]).toEqual({
      worker: "w1",
      branch: `fleet/${RUN_ID}/w1`,
      base_ref: baseSha,
      repo,
    });
    // The workdir-less task falls back to its (unusable) worktree rather
    // than being dropped: an uncheckable branch is a row, not an omission.
    expect(seen.some((i) => i.worker === "w3")).toBe(true);
  });

  // Would fail if a throwing pre-check killed the report: the merge section
  // degrades to empty with a note, everything else survives.
  test("a pre-check failure degrades the report instead of aborting it", async () => {
    const { report, notes } = await collectRunReport(runPaths(RUN_ID, runsDir), {
      precheck: async () => {
        throw new Error("git exploded");
      },
    });
    expect(report.merge).toEqual([]);
    expect(report.schedule.length).toBeGreaterThan(0);
    expect(notes.some((n) => n.includes("merge pre-check failed"))).toBe(true);
  });
});
