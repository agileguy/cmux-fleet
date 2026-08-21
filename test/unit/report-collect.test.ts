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
import { collectRunReport, TASK_ENVELOPE_SCHEMA } from "../../src/report/collect.ts";
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
    // The worker's OWN checkout (`host_workdir`, here `wtGood`), not the
    // parent `repo` — under the clone-based isolation design a worker's
    // branch is created inside its own independent clone and never fetched
    // into the parent, so checking the parent would fail to resolve it for
    // every real worktree-isolated worker (this fixture's `wtGood` happens to
    // be a linked `git worktree add` sharing the parent's refs either way,
    // which is exactly why this assertion has to pin the FIELD CHOSEN rather
    // than merely "the check still finds the branch somewhere").
    expect(w1[0]).toEqual({
      worker: "w1",
      branch: `fleet/${RUN_ID}/w1`,
      base_ref: baseSha,
      repo: wtGood,
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

  /**
   * THE regression test for this fix. Every fixture above is a `git worktree
   * add` linked worktree, which shares the parent's refs regardless of which
   * path the merge pre-check is pointed at — so none of them can fail under
   * the bug this guards against. This one is built the way `run/worktree.ts`
   * ACTUALLY builds a worker checkout now: an independent `git clone
   * --no-hardlinks`, with `origin` stripped, whose branch exists ONLY inside
   * the clone. Checking it against the parent (the pre-fix preference) makes
   * `git -C <parent> rev-parse <branch>` fail to resolve, and the merge
   * section silently degrades to "does not resolve; nothing was checked" for
   * a branch that is, in fact, perfectly clean.
   */
  test("a worker's branch that exists only in its own clone still resolves", async () => {
    const cloneId = "2026-07-27T00-00-02Z-clon";
    const cloneRunDir = join(runsDir, cloneId);
    const cloneRepo = join(tmp, "clone-parent");
    const workerClone = join(tmp, "clone-worker");

    await mkdir(cloneRepo, { recursive: true });
    await git(cloneRepo, "init", "-q", "-b", "main");
    await git(cloneRepo, "config", "user.email", "fixture@test");
    await git(cloneRepo, "config", "user.name", "fixture");
    await writeFile(join(cloneRepo, "f.txt"), "one\n");
    await git(cloneRepo, "add", ".");
    await git(cloneRepo, "commit", "-q", "-m", "base");
    const cloneBaseSha = (await git(cloneRepo, "rev-parse", "HEAD")).trim();

    // The real mechanism: an independent clone, never `git worktree add`.
    await git(cloneRepo, "clone", "-q", "--no-hardlinks", "--single-branch", "--branch", "main", cloneRepo, workerClone);
    const branch = `fleet/${cloneId}/w1`;
    await git(workerClone, "switch", "-q", "-c", branch);
    await git(workerClone, "remote", "remove", "origin");
    // The branch has never existed anywhere but this clone: the parent's own
    // refs cannot resolve it, which is exactly the property this test needs.
    const parentSeesBranch = await git(cloneRepo, "rev-parse", "--verify", `${branch}^{commit}`)
      .then(() => true)
      .catch(() => false);
    expect(parentSeesBranch).toBe(false);

    await mkdir(join(cloneRunDir, "inbox"), { recursive: true });
    await writeFile(join(cloneRunDir, "run.json"), JSON.stringify({ run_id: cloneId }));
    await writeFile(
      join(cloneRunDir, "inbox", "T-clone.json"),
      JSON.stringify({
        schema: "pifleet.task/v1",
        task_id: "T-clone",
        run_id: cloneId,
        epoch: 1,
        attempt: 1,
        worker: "w1",
        dispatched_at: new Date().toISOString(),
        title: "T-clone",
        brief: "clone fixture",
        repo: cloneRepo,
        host_workdir: workerClone,
        container_workdir: "/workspace",
        branch,
        base_ref: cloneBaseSha,
        outbox: "/outbox/T-clone",
        deadline_s: 1500,
      }),
    );

    const { report } = await collectRunReport(runPaths(cloneId, runsDir));
    expect(report.merge).toHaveLength(1);
    // `clean: true` (a no-op merge, branch === base) is only reachable if the
    // pre-check resolved the branch AT ALL. Under the pre-fix preference this
    // entry is `branch ... does not resolve; nothing was checked` instead.
    expect(report.merge[0]).toMatchObject({ worker: "w1", clean: true });
  });
});

/**
 * Two ways the report stopped being a report.
 *
 * Both were found by constructing the input rather than by reading, and both
 * hit `report` at exactly the moment an operator reaches for it: a large fleet,
 * and a run that went wrong.
 */
describe("the report degrades rather than crashing or over-claiming", () => {
  /** A run dir whose only content is a schedule snapshot of `n` valid rows. */
  async function runWithSchedule(rows: unknown[], tag: string): Promise<string> {
    const id = `2026-07-27T00-00-00Z-${tag}`;
    const rp = runPaths(id, runsDir);
    await mkdir(rp.workersDir, { recursive: true });
    await writeFile(rp.runJson, JSON.stringify({ run_id: id }), "utf8");
    await writeFile(rp.scheduleJson, JSON.stringify({ tasks: rows }), "utf8");
    return id;
  }

  /**
   * `RunReportSchema` caps its arrays at MAX_ITEMS and `parse` THROWS rather
   * than truncating, so a fleet of more than a thousand tasks produced no
   * report at all — on the run that needs one most.
   */
  test("a schedule larger than the schema cap still produces a report", async () => {
    const rows = Array.from({ length: 1200 }, (_, i) => ({
      id: `t-${i}`,
      state: "waiting",
      depends_on: [],
    }));
    const id = await runWithSchedule(rows, "big1");
    const { report, notes } = await collectRunReport(runPaths(id, runsDir), {
      precheck: async () => [],
    });
    // Rows are capped to fit the wire schema...
    expect(report.schedule.length).toBe(1000);
    // ...but the counts tell the truth about the run, not about the array.
    expect(report.totals.tasks).toBe(1200);
    // And the truncation is SAID. A silent cap reads as "covered everything".
    expect(notes.join(" ")).toMatch(/1200 tasks.*first 1000/);
  });

  /**
   * `done` is the one state the snapshot must not be able to assert. The
   * verdict was already refused for an undispatched row; the state was not,
   * so a snapshot could donate a completed task the inbox cannot show was
   * ever dispatched — and `totals.done` counted it.
   */
  test("the snapshot cannot report a task done that was never dispatched", async () => {
    const id = await runWithSchedule(
      [
        { id: "t-never-ran", state: "done", task_id: null, verdict: "success" },
        { id: "t-honest", state: "waiting", depends_on: [] },
      ],
      "lie1",
    );
    const { report, notes } = await collectRunReport(runPaths(id, runsDir), {
      precheck: async () => [],
    });
    const row = report.schedule.find((r) => r.id === "t-never-ran");
    expect(row?.state).not.toBe("done");
    expect(row?.verdict).toBeNull();
    expect(report.totals.done).toBe(0);
    // Refusing quietly would leave the operator wondering where the task went.
    expect(notes.join(" ")).toContain("t-never-ran");
  });

  /**
   * The positive control. Scheduling states ARE the snapshot's to assert —
   * nothing else in the run records them — so a fix that distrusted the whole
   * file would erase the graph and pass the two tests above.
   */
  test("waiting, ready and blocked are still taken from the snapshot", async () => {
    const id = await runWithSchedule(
      [
        { id: "t-w", state: "waiting", depends_on: ["t-b"] },
        { id: "t-r", state: "ready", depends_on: [] },
        { id: "t-b", state: "blocked", blocked_by: "t-x" },
      ],
      "ctrl1",
    );
    const { report } = await collectRunReport(runPaths(id, runsDir), { precheck: async () => [] });
    const byId = new Map(report.schedule.map((r) => [r.id, r.state]));
    expect(byId.get("t-w")).toBe("waiting");
    expect(byId.get("t-r")).toBe("ready");
    expect(byId.get("t-b")).toBe("blocked");
  });
});

/**
 * The attended record is corroborated, not merely read.
 *
 * `attended.json` was the only evidence that a person had driven a worker,
 * which made "was this run autonomous" a question one `rm` could change the
 * answer to. An unreadable record already failed safe; an ABSENT one failed
 * open, and every verdict in the report silently regained a meaning it had
 * not earned. `tui` also appends `tui_entered` to the append-only ledger, so
 * the two would have to be tampered with together.
 */
describe("a deleted attended record cannot make a run look autonomous", () => {
  async function runWithLedger(tag: string, ledgerLine: string | null): Promise<string> {
    const id = `2026-07-27T00-00-00Z-${tag}`;
    const rp = runPaths(id, runsDir);
    await mkdir(join(rp.workersDir, "eng-1"), { recursive: true });
    await mkdir(rp.ledgerDir, { recursive: true });
    await writeFile(rp.runJson, JSON.stringify({ run_id: id }), "utf8");
    if (ledgerLine !== null) {
      await writeFile(join(rp.ledgerDir, "cli-tui-1.jsonl"), `${ledgerLine}\n`, "utf8");
    }
    return id;
  }

  const enteredLine = (runId: string): string =>
    JSON.stringify({
      seq: 1,
      ts: "2026-07-27T00:00:00.000Z",
      actor: "cli-tui-1",
      run_id: runId,
      event: "tui_entered",
      worker: "eng-1",
    });

  test("a tui_entered ledger entry with no record still reports the run as attended", async () => {
    const id = `2026-07-27T00-00-00Z-att9`;
    await runWithLedger("att9", enteredLine(id));
    const { attended, attendedUnverified } = await collectRunReport(runPaths(id, runsDir), {
      precheck: async () => [],
    });
    // Not a note: `attended: []` beside a note in `collection_notes` is what
    // let a tampered run read as autonomous to anything consuming the JSON.
    expect(attended).toEqual([]);
    expect(attendedUnverified.map((u) => u.worker)).toEqual(["eng-1"]);
    expect(attendedUnverified[0]?.reason).toMatch(/ledger records a human session/);
  });

  /**
   * The positive control, and it is load-bearing: a fix that simply declared
   * every run attended would pass the test above and make the whole signal
   * meaningless.
   */
  test("a run nothing ever attended reports no attendance at all", async () => {
    const id = `2026-07-27T00-00-00Z-att8`;
    await runWithLedger("att8", null);
    const { attended, attendedUnverified } = await collectRunReport(runPaths(id, runsDir), {
      precheck: async () => [],
    });
    expect(attended).toEqual([]);
    expect(attendedUnverified).toEqual([]);
  });
});

/**
 * The durability half, which the suite proved it was blind to.
 *
 * Review mutation-tested this area and found the pattern exactly: every
 * ORDERING and lifecycle hazard was pinned, and every DURABILITY and tamper
 * hazard was invisible. Three mutations passed untouched — dropping the note
 * for an unreadable record, deleting most of the voided table, and making
 * `readAttended` return null instead of throwing on corrupt JSON. The last
 * is the dangerous one: it is a plausible "consistency" refactor that turns
 * a corrupt record into "never attended" with no signal at all.
 */
describe("an unreadable attended record is never silently dropped", () => {
  async function runWithBadRecord(tag: string, body: string): Promise<string> {
    const id = `2026-07-27T00-00-00Z-${tag}`;
    const rp = runPaths(id, runsDir);
    const wp = join(rp.workersDir, "eng-1");
    await mkdir(wp, { recursive: true });
    await writeFile(rp.runJson, JSON.stringify({ run_id: id }), "utf8");
    await writeFile(join(wp, "attended.json"), body, "utf8");
    return id;
  }

  test("a truncated record surfaces as unverified, not as an empty attended list", async () => {
    const id = await runWithBadRecord("trunc", '{"schema":"pifleet.attended/v1","worker":');
    const { attended, attendedUnverified } = await collectRunReport(runPaths(id, runsDir), {
      precheck: async () => [],
    });
    // `attended: []` is an AFFIRMATIVE claim that nobody drove this run, so
    // the signal cannot live only in its absence.
    expect(attended).toEqual([]);
    expect(attendedUnverified.map((u) => u.worker)).toEqual(["eng-1"]);
    expect(attendedUnverified[0]?.reason).toMatch(/cannot be read/);
  });

  /**
   * Schema-invalid rather than syntactically broken: the shape a partial
   * write or an older writer produces. It must not be read as "no record".
   */
  test("a schema-invalid record surfaces as unverified too", async () => {
    const id = await runWithBadRecord("badsc", JSON.stringify({ schema: "wrong/v1", worker: 3 }));
    const { attended, attendedUnverified } = await collectRunReport(runPaths(id, runsDir), {
      precheck: async () => [],
    });
    expect(attended).toEqual([]);
    expect(attendedUnverified.map((u) => u.worker)).toEqual(["eng-1"]);
  });

  /**
   * The positive control for both: a VALID record must still be reported as
   * attended and must NOT appear as unverified, or a fix that flagged every
   * record as suspect would pass the two tests above.
   */
  test("a valid record is reported attended and is not flagged unverified", async () => {
    const id = await runWithBadRecord(
      "good",
      JSON.stringify({
        schema: "pifleet.attended/v1",
        worker: "eng-1",
        mode: "viewer",
        entered_at: "2026-07-27T00:00:00.000Z",
        left_at: "2026-07-27T00:05:00.000Z",
        voided: [{ isc: "ISC-93", because: "a person's edits can supply the diff" }],
      }),
    );
    const { attended, attendedUnverified } = await collectRunReport(runPaths(id, runsDir), {
      precheck: async () => [],
    });
    expect(attended.map((a) => a.worker)).toEqual(["eng-1"]);
    expect(attendedUnverified).toEqual([]);
  });
});

/**
 * The dispatch envelope's durable format (ISC-192).
 *
 * `collectDispatched` used to parse an envelope in one unwrapped line
 * (`TaskEnvelopeSchema.parse(await Bun.file(...).json())`) and hand whatever
 * the library threw to `firstLine`. A `ZodError`'s `message` is a
 * pretty-printed JSON array, so its first line is the bare character `[` — the
 * note an operator actually read was `inbox/t-1.json is unreadable: [`, which
 * names neither the problem nor the file's provenance.
 *
 * THE POLICY IS UNCHANGED AND THAT IS DELIBERATE. This module's header says
 * failures of collection are findings, not exceptions, so one unreadable
 * envelope stays one degraded row rather than becoming a refused report. These
 * tests pin that as hard as they pin the diagnosis: a "fix" that aborted the
 * whole report over one bad envelope would break `report` for exactly the runs
 * it exists to describe.
 */
describe("an inbox envelope this build cannot read", () => {
  async function runWithEnvelope(tag: string, taskId: string, body: string): Promise<string> {
    const id = `2026-08-20T00-00-00Z-${tag}`;
    const rp = runPaths(id, runsDir);
    await mkdir(rp.inboxDir, { recursive: true });
    await writeFile(rp.runJson, JSON.stringify({ run_id: id }), "utf8");
    await writeFile(join(rp.inboxDir, `${taskId}.json`), body, "utf8");
    return id;
  }

  const collect = (id: string) =>
    collectRunReport(runPaths(id, runsDir), { precheck: async () => [] });

  test("an unrecognised stamp is named as another build's, not as corruption", async () => {
    const id = await runWithEnvelope("envv2", "t-1", JSON.stringify({ schema: "pifleet.task/v2", task_id: "t-1" }));
    const { notes, report } = await collect(id);

    const note = notes.find((n) => n.includes("inbox/t-1.json")) ?? "";
    // The bare `[` this replaces — a note that says nothing at all.
    expect(note).not.toContain("unreadable: [");
    expect(note).toContain("another build");
    expect(note).toContain("pifleet.task/v2");
    expect(note).toContain(TASK_ENVELOPE_SCHEMA);
    // The hatch, so the refusal is not a dead end.
    expect(note).toContain("re-run 'report'");

    // AND THE REPORT STILL EXISTS. One bad envelope is one degraded row.
    expect(RunReportSchema.parse(report)).toBeTruthy();
  });

  test("a damaged envelope is a DIFFERENT note, and carries the bytes", async () => {
    const id = await runWithEnvelope("envtrunc", "t-2", '{"schema":"pifleet.task/v1","task_id":');
    const { notes } = await collect(id);

    const note = notes.find((n) => n.includes("inbox/t-2.json")) ?? "";
    expect(note).not.toContain("unreadable: [");
    // Damage, not provenance: an operator told "another build" would go and
    // change binaries over a truncated file.
    expect(note).not.toContain("another build");
    expect(note).toContain("bytes on disk");
  });

  test("the RIGHT stamp with a wrong field names the FIELD, not the array", async () => {
    const id = await runWithEnvelope(
      "envfield",
      "t-3",
      JSON.stringify({ schema: TASK_ENVELOPE_SCHEMA, task_id: "t-3", run_id: "r", epoch: 0 }),
    );
    const { notes } = await collect(id);

    const note = notes.find((n) => n.includes("inbox/t-3.json")) ?? "";
    expect(note).not.toContain("unreadable: [");
    // The field path is the whole diagnostic value at this point.
    expect(note).toMatch(/attempt|worker|title|base_ref/);
  });

  test("one unreadable envelope never costs the report — the surrounding policy", async () => {
    // The task must still be REPORTED, with `envelope: null` and a harvested
    // verdict, because `report` is what an operator runs when things went
    // wrong. Aborting here would be a new policy imposed on a module that
    // already answered this question the other way.
    const id = await runWithEnvelope("envrow", "t-4", "not json at all");
    const { report, notes } = await collect(id);

    expect(notes.some((n) => n.includes("inbox/t-4.json"))).toBe(true);
    const parsed = RunReportSchema.parse(report);
    expect(parsed.schedule.some((t) => t.task_id === "t-4")).toBe(true);
    // Degraded, and saying so: the row exists with no dispatch record behind it.
    expect(parsed.totals.tasks).toBeGreaterThan(0);
  });
});
