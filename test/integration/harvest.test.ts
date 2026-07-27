/**
 * A1/A2 harvest against a REAL repository (SRD §8.2, §8.4) — ISC-88, ISC-89,
 * ISC-90, ISC-94, ISC-151, and the §7.2 primacy rule.
 *
 * Everything here is a real subprocess on a real filesystem: `git init`, real
 * commits, a real worktree, and the actual CLI spawned as a caller would spawn
 * it. The CLI tests spawn `src/cli/index.ts` rather than importing harvest
 * functions, because importing would leave the command wiring — the thing
 * ISC-88 is actually about — pinned by nothing.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HarvestSchema, VerdictSchema } from "../../src/contracts.ts";
import { deriveGitFacts } from "../../src/harvest/git.ts";

const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;
const RUN_ID = "2026-07-27T00-00-00Z-hrvt";

let tmp: string;
let repo: string;
let worktree: string;
let runsDir: string;
let runDir: string;
let baseSha: string;
let mainAdvancedSha: string;

/** The nasty filename that proves argv-array spawning: a shell would run it. */
const NASTY = "a b;$(touch pwned).txt";

async function run(cmd: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(cmd, { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`${cmd.join(" ")} failed (${code}): ${err}`);
  return out;
}

const git = (repoDir: string, ...args: string[]): Promise<string> =>
  run(["git", "-C", repoDir, ...args], repoDir);

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, PIFLEET_RUNS_DIR: runsDir },
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

function taskEnvelope(taskId: string, worker: string, workdir: string): Record<string, unknown> {
  return {
    schema: "pifleet.task/v1",
    task_id: taskId,
    run_id: RUN_ID,
    epoch: 1,
    attempt: 1,
    worker,
    dispatched_at: new Date().toISOString(),
    title: taskId,
    brief: "integration fixture",
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
  tmp = await mkdtemp(join(tmpdir(), "pifleet-harvest-"));
  repo = join(tmp, "repo");
  worktree = join(repo, ".worktrees", "w1");
  runsDir = join(tmp, "runs");
  runDir = join(runsDir, RUN_ID);

  // A real repository with a real base commit.
  await mkdir(repo, { recursive: true });
  await git(repo, "init", "-q", "-b", "main");
  await git(repo, "config", "user.email", "fixture@test");
  await git(repo, "config", "user.name", "fixture");
  await writeFile(join(repo, "a.txt"), "one\ntwo\nthree\n");
  await mkdir(join(repo, "src"), { recursive: true });
  await writeFile(join(repo, "src", "keep.ts"), "export const keep = 1;\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "base");
  baseSha = (await git(repo, "rev-parse", "HEAD")).trim();

  // The worker's worktree, branched at base, with two commits of real work —
  // including a filename a shell would EXECUTE, which is exactly why runGit
  // must spawn argv arrays.
  await git(repo, "worktree", "add", "-q", "-b", `fleet/${RUN_ID}/w1`, worktree, baseSha);
  await writeFile(join(worktree, "a.txt"), "one\nCHANGED\nthree\nfour\n");
  await writeFile(join(worktree, NASTY), "harmless content\n");
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-q", "-m", "edit a.txt; add hostile filename");
  await writeFile(join(worktree, "src", "new.ts"), "export const added = true;\n");
  await git(worktree, "add", ".");
  await git(worktree, "commit", "-q", "-m", "add src/new.ts");

  // Advance main past the branch point, so main's new head is a real commit
  // that is NOT an ancestor of the worker branch — the ISC-151 fixture.
  await writeFile(join(repo, "a.txt"), "rewritten on main\n");
  await git(repo, "add", ".");
  await git(repo, "commit", "-q", "-m", "main moved on");
  mainAdvancedSha = (await git(repo, "rev-parse", "HEAD")).trim();

  // A second worktree with NO commits, for the §7.2 empty-diff rule.
  await git(repo, "worktree", "add", "-q", "-b", `fleet/${RUN_ID}/w2`, join(repo, ".worktrees", "w2"), baseSha);

  // The run directory: dispatch records + outbox envelopes.
  await mkdir(join(runDir, "inbox"), { recursive: true });
  await writeFile(join(runDir, "run.json"), JSON.stringify({ run_id: RUN_ID }));

  // T-1: honest worker — envelope matches the diff exactly.
  await writeFile(join(runDir, "inbox", "T-1.json"), JSON.stringify(taskEnvelope("T-1", "w1", worktree)));
  await mkdir(join(runDir, "outbox", "w1", "T-1", "files"), { recursive: true });
  await writeFile(join(runDir, "outbox", "w1", "T-1", "files", "note.md"), "artifact\n");
  await writeFile(
    join(runDir, "outbox", "w1", "T-1", "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: "T-1",
      epoch: 1,
      worker: "w1",
      status: "success",
      summary: "did the work",
      files_changed: [
        { path: "a.txt", change: "modified" },
        { path: NASTY, change: "added" },
        { path: "src/new.ts", change: "added" },
      ],
      artifacts: [{ kind: "file", path: "/outbox/T-1/files/note.md" }],
    }),
  );

  // T-2: same work, worker died before writing an envelope (ISC-94).
  await writeFile(join(runDir, "inbox", "T-2.json"), JSON.stringify(taskEnvelope("T-2", "w1", worktree)));

  // T-3: no commits at all, but the envelope claims success (§7.2).
  await writeFile(
    join(runDir, "inbox", "T-3.json"),
    JSON.stringify(taskEnvelope("T-3", "w2", join(repo, ".worktrees", "w2"))),
  );
  await mkdir(join(runDir, "outbox", "w2", "T-3"), { recursive: true });
  await writeFile(
    join(runDir, "outbox", "w2", "T-3", "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: "T-3",
      epoch: 1,
      worker: "w2",
      status: "success",
      summary: "definitely did lots of work",
    }),
  );

  // T-4: real work, but the envelope claims a file the diff does not contain (F5).
  await writeFile(join(runDir, "inbox", "T-4.json"), JSON.stringify(taskEnvelope("T-4", "w1", worktree)));
  await mkdir(join(runDir, "outbox", "w1", "T-4"), { recursive: true });
  await writeFile(
    join(runDir, "outbox", "w1", "T-4", "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: "T-4",
      epoch: 1,
      worker: "w1",
      status: "success",
      files_changed: [{ path: "phantom.ts", change: "modified" }],
    }),
  );

  // T-conceal: real work, envelope reports only PART of the diff. The other
  // direction of F5 (§880) — concealment, not fabrication.
  await writeFile(
    join(runDir, "inbox", "T-conceal.json"),
    JSON.stringify(taskEnvelope("T-conceal", "w1", worktree)),
  );
  await mkdir(join(runDir, "outbox", "w1", "T-conceal"), { recursive: true });
  await writeFile(
    join(runDir, "outbox", "w1", "T-conceal", "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: "T-conceal",
      epoch: 1,
      worker: "w1",
      status: "success",
      summary: "touched one file, honest",
      // The diff also contains NASTY and src/new.ts. Both are omitted.
      files_changed: [{ path: "a.txt", change: "modified" }],
    }),
  );

  // T-harness: a worker whose diff edits the test runner's own config. The
  // ISC-150 cap must refuse to certify success over a suite the graded actor
  // could have rewritten.
  const hw = join(repo, ".worktrees", "w3");
  await git(repo, "worktree", "add", "-q", "-b", `fleet/${RUN_ID}/w3`, hw, baseSha);
  await writeFile(join(hw, "bunfig.toml"), '[test]\npreload = ["./sneak.ts"]\n');
  await writeFile(join(hw, "sneak.ts"), "// makes the red suite green\n");
  await git(hw, "add", ".");
  await git(hw, "commit", "-q", "-m", "adjust test config");
  await writeFile(join(runDir, "inbox", "T-harness.json"), JSON.stringify(taskEnvelope("T-harness", "w3", hw)));
  await mkdir(join(runDir, "outbox", "w3", "T-harness"), { recursive: true });
  await writeFile(
    join(runDir, "outbox", "w3", "T-harness", "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: "T-harness",
      epoch: 1,
      worker: "w3",
      status: "success",
      summary: "all tests pass",
      files_changed: [
        { path: "bunfig.toml", change: "added" },
        { path: "sneak.ts", change: "added" },
      ],
    }),
  );

  // T-abort: real work and a claimed success, but the SUPERVISOR settled the
  // epoch as aborted. A fact about the run outranks any inference from the tree.
  await writeFile(join(runDir, "inbox", "T-abort.json"), JSON.stringify(taskEnvelope("T-abort", "w1", worktree)));
  await mkdir(join(runDir, "outbox", "w1", "T-abort"), { recursive: true });
  await writeFile(
    join(runDir, "outbox", "w1", "T-abort", "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: "T-abort",
      epoch: 1,
      worker: "w1",
      status: "success",
      summary: "finished cleanly, honest",
      files_changed: [
        { path: "a.txt", change: "modified" },
        { path: NASTY, change: "added" },
        { path: "src/new.ts", change: "added" },
      ],
    }),
  );
  await mkdir(join(runDir, "workers", "w1", "tasks"), { recursive: true });
  await writeFile(
    join(runDir, "workers", "w1", "tasks", "T-abort.json"),
    JSON.stringify({
      schema: "pifleet.taskrecord/v1",
      task_id: "T-abort",
      attempt_id: "att-1",
      worker: "w1",
      run_id: RUN_ID,
      epoch: 1,
      verdict: "aborted",
      reason: "operator abort",
      settled_at: new Date().toISOString(),
    }),
  );
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe("deriveGitFacts — A2 is the repository, verbatim", () => {
  // ISC-90: the reported facts must equal what git itself reports. The
  // oracles here are independent `git` invocations, not re-implementations —
  // the ISC's own wording names `git diff` as the ground truth. Would fail if
  // fact derivation drifted from git (wrong range syntax, wrong flags, lossy
  // parsing).
  test("commits, files and diff equal git's own answers", async () => {
    const g = await deriveGitFacts(worktree, baseSha);
    expect(g.ok).toBe(true);
    expect(g.facts.base_is_ancestor).toBe(true);
    expect(g.facts.head_ref).toBe((await git(worktree, "rev-parse", "HEAD")).trim());

    const oracleCommits = (await git(worktree, "rev-list", `${baseSha}..HEAD`))
      .trim()
      .split("\n");
    expect(g.facts.commits).toEqual(oracleCommits);

    const paths = g.facts.files_changed.map((f) => f.path).sort();
    expect(paths).toEqual(["a.txt", NASTY, "src/new.ts"].sort());

    const oracleDiff = await git(worktree, "diff", `${baseSha}...HEAD`);
    expect(g.diffText).toBe(oracleDiff); // ISC-90, byte for byte
    expect(g.facts.diff_bytes).toBe(Buffer.byteLength(oracleDiff, "utf8"));
  });

  // Would fail if runGit ever routed through a shell: `$(touch pwned)` in the
  // tracked filename would execute and leave the marker file behind.
  test("hostile filenames are inert bytes, never shell input", async () => {
    await deriveGitFacts(worktree, baseSha);
    expect(existsSync(join(worktree, "pwned"))).toBe(false);
    expect(existsSync(join(repo, "pwned"))).toBe(false);
  });

  // ISC-151. Would fail if the merge-base gate were dropped: git happily
  // diffs against a non-ancestor via the remaining merge-base, producing a
  // small plausible diff that would be reported as the task's work.
  test("a non-ancestor base withholds diff facts entirely", async () => {
    const g = await deriveGitFacts(worktree, mainAdvancedSha);
    expect(g.ok).toBe(true);
    expect(g.facts.base_is_ancestor).toBe(false);
    expect(g.diffText).toBeNull();
    expect(g.facts.files_changed).toEqual([]);
    expect(g.facts.commits).toEqual([]);
    expect(g.reasons.join(" ")).toContain("ISC-151");
  });

  test("a directory that is not a repository reports unknown, not a throw", async () => {
    const g = await deriveGitFacts(tmp, baseSha);
    expect(g.ok).toBe(false);
    expect(g.facts.head_ref).toBeNull();
  });
});

describe("pifleet artifacts — the harvest API (§8.4)", () => {
  // ISC-88 + ISC-89, at the real CLI surface. Would fail if the emitted
  // object drifted from HarvestSchema or the verdict left the §7.3 domain.
  test("--task --json emits a HarvestSchema-valid object, exit 0", async () => {
    const r = await runCli(["artifacts", "--run", RUN_ID, "--task", "T-1", "--json"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    const h = HarvestSchema.parse(obj); // ISC-88
    VerdictSchema.parse(h.verdict); // ISC-89
    expect(h.task_id).toBe("T-1");
    expect(h.worker).toBe("w1");
    // Derived unknown (acceptance is E3) + claimed success → success; the
    // envelope may settle an unknown, it just may never upgrade a derived
    // failure (§7.3).
    expect(h.verdict).toBe("success");
    expect(h.claimed).not.toBeNull();
    expect(h.discrepancies).toEqual([]);
    expect(obj["harvest_status"]).toBe("complete");
  });

  // ISC-90 at the CLI: --include diff must carry git's diff, not a summary
  // of it. Would fail if the include plumbing dropped or reformatted it.
  test("--include diff attaches the verbatim diff", async () => {
    const r = await runCli(["artifacts", "--run", RUN_ID, "--task", "T-1", "--include", "diff", "--json"]);
    expect(r.code).toBe(0);
    const h = HarvestSchema.parse(JSON.parse(r.stdout));
    const oracleDiff = await git(worktree, "diff", `${baseSha}...HEAD`);
    expect(h.derived.diff).toBe(oracleDiff);
  });

  // ISC-94. Would fail if a missing envelope were treated as a failure: the
  // verdict must stay in the un-downgraded domain and the harvest must stay
  // complete — the repository facts are all present.
  test("a missing envelope yields claimed:null without downgrading", async () => {
    const r = await runCli(["artifacts", "--run", RUN_ID, "--task", "T-2", "--json"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    const h = HarvestSchema.parse(obj);
    expect(h.claimed).toBeNull();
    expect(h.verdict).toBe("unknown"); // real diff exists; nothing proves or disproves it
    expect(obj["harvest_status"]).toBe("complete");
  });

  // The §7.2 primacy rule, verbatim: claimed success over an empty diff and
  // no commits is reported failed. Would fail if adjudication started
  // trusting the envelope over the repository.
  test("claimed success with an empty diff is failed", async () => {
    const r = await runCli(["artifacts", "--run", RUN_ID, "--task", "T-3", "--json"]);
    expect(r.code).toBe(0);
    const h = HarvestSchema.parse(JSON.parse(r.stdout));
    expect(h.verdict).toBe("failed");
  });

  // F5 (§8.2, §13): a self-report contradicted by the diff is a hard failure
  // class. Would fail if the files_changed cross-check were removed — the
  // claimed success would then sail through as T-1's did.
  test("claiming a file the diff does not contain is failed with a discrepancy", async () => {
    const r = await runCli(["artifacts", "--run", RUN_ID, "--task", "T-4", "--json"]);
    expect(r.code).toBe(0);
    const h = HarvestSchema.parse(JSON.parse(r.stdout));
    expect(h.verdict).toBe("failed");
    expect(h.discrepancies.join(" ")).toContain("phantom.ts");
  });

  /**
   * The other direction of F5, on the live CLI path.
   *
   * SRD §880 makes *disagreement* between the envelope's `files_changed` and
   * the diff a hard failure class, unqualified. Two implementations of that
   * rule existed and contradicted each other: the one `artifacts` actually
   * reached treated under-claiming as "sloppy, not falsifying" and only
   * floored the verdict for over-claiming, while the one with the test suite
   * — and no production caller — called under-claiming concealment and failed
   * it. Wiring the spec-correct module is what makes this test possible; it
   * would have passed as `success` before.
   */
  test("concealing a file the diff does contain is also failed (F5, §880)", async () => {
    const r = await runCli(["artifacts", "--run", RUN_ID, "--task", "T-conceal", "--json"]);
    expect(r.code).toBe(0);
    const h = HarvestSchema.parse(JSON.parse(r.stdout));
    expect(h.verdict).toBe("failed");
    expect(h.discrepancies.join(" ")).toContain("src/new.ts");
  });

  /**
   * ISC-150 on the live CLI path, which is the part that was missing: the cap
   * was implemented and unit-tested in a module `artifacts` did not call, and
   * `facts.harness` was never populated, so `touched` was permanently empty
   * and the cap could not fire whatever the worker edited.
   *
   * `bunfig.toml` is the specific file the bypass was found through — the
   * config for the runner this repository itself uses.
   */
  test("a diff touching the runner's own config caps the verdict (ISC-150)", async () => {
    const r = await runCli(["artifacts", "--run", RUN_ID, "--task", "T-harness", "--json"]);
    expect(r.code).toBe(0);
    const h = HarvestSchema.parse(JSON.parse(r.stdout));
    // Claimed success, real commits, honest file list — and still not success,
    // because the actor could have rewritten the exam.
    expect(h.verdict).not.toBe("success");
    expect(h.reasons.join(" ")).toContain("harness");
  });

  /**
   * ISC-153 is "hashed AND recorded". The hash was being computed and dropped,
   * which satisfies neither half: a verdict whose evidence cannot be
   * identified is not reviewable, and an operator disputing one needs to know
   * whether the facts have changed since.
   *
   * Asserted as a REPLAY KEY, not as a string: stable across identical reads,
   * and different for a task whose facts differ. Pinning a literal digest
   * would test the hash function instead.
   */
  test("the recorded facts_hash identifies the evidence (ISC-153)", async () => {
    const read = async (task: string) => {
      const r = await runCli(["artifacts", "--run", RUN_ID, "--task", task, "--json"]);
      expect(r.code).toBe(0);
      return HarvestSchema.parse(JSON.parse(r.stdout));
    };
    const a = await read("T-1");
    const b = await read("T-1");
    const other = await read("T-3");

    expect(a.facts_hash).not.toBeNull();
    expect(a.facts_hash).toMatch(/^[0-9a-f]{64}$/);
    // Same facts, same key — otherwise it cannot be used to detect change.
    expect(b.facts_hash).toBe(a.facts_hash);
    // Different facts, different key — otherwise it detects nothing.
    expect(other.facts_hash).not.toBe(a.facts_hash);
  });

  /**
   * A supervisor-terminal verdict outranks derived evidence (§7.3). `aborted`
   * and `timed_out` are facts about the RUN, not inferences from the tree, so
   * no amount of clean diff and no self-report makes an aborted task complete.
   *
   * Pinned because the adjudicator rewiring restructured exactly this branch:
   * the override used to be tangled with the F5 special case, and a task the
   * operator killed silently reporting `success` is the worst way to find out
   * it was dropped.
   */
  test("a supervisor-aborted epoch reports aborted, whatever the diff says", async () => {
    const r = await runCli(["artifacts", "--run", RUN_ID, "--task", "T-abort", "--json"]);
    expect(r.code).toBe(0);
    const h = HarvestSchema.parse(JSON.parse(r.stdout));
    expect(h.verdict).toBe("aborted");
    expect(h.reasons.join(" ")).toContain("aborted");
  });

  // The §8.4 pure-read rule. Would fail if an unknown task became a CliError:
  // a machine consumer must read `harvest_status`, never the exit code, to
  // tell "no artifacts" from "tool broke".
  test("an unknown task is exit 0 with harvest_status unavailable", async () => {
    const r = await runCli(["artifacts", "--run", RUN_ID, "--task", "T-NOPE", "--json"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout) as Record<string, unknown>;
    HarvestSchema.parse(obj);
    expect(obj["harvest_status"]).toBe("unavailable");
    expect((obj as { verdict: string }).verdict).toBe("unknown");
  });

  // Would fail if --all stopped enumerating the inbox or dropped tasks: it is
  // the single end-of-fanout call and must cover every dispatch record.
  test("--all --json covers every dispatched task, exit 0", async () => {
    const r = await runCli(["artifacts", "--run", RUN_ID, "--all", "--json"]);
    expect(r.code).toBe(0);
    const obj = JSON.parse(r.stdout) as { run_id: string; tasks: Array<Record<string, unknown>> };
    expect(obj.run_id).toBe(RUN_ID);
    // Containment, not equality: another test in this file creates a task of
    // its own, so an exact list makes this assertion depend on test ORDER —
    // green today, red the day the runner reorders. Every dispatched fixture
    // must appear, which is what "covers every dispatched task" means; an
    // extra one from a sibling test is not a failure of that property.
    const ids = obj.tasks.map((t) => t["task_id"]);
    for (const id of ["T-1", "T-2", "T-3", "T-4", "T-conceal"]) expect(ids).toContain(id);
    for (const t of obj.tasks) HarvestSchema.parse(t); // ISC-88 for the fanout shape
  });

  // Usage errors are the one legitimate nonzero: neither task nor all named.
  /**
   * §8.4, the whole-run guarantee. `--all` reads N tasks' worker-controlled
   * files; one of them failing in a way no refusal path anticipated used to
   * throw out of `harvestAll`'s unguarded loop and out of the command, which
   * exited 2 having emitted NO JSON — so a single poisoned task destroyed
   * every healthy task's harvest in the same run.
   *
   * A mode-000 `result.json` is the cheapest real instance: it lstats fine and
   * the `open` fails, which is also an EACCES/ENFILE race in production.
   */
  test("an unreadable envelope degrades that task alone, not the run", async () => {
    const poisoned = join(runDir, "outbox", "w1", "T-poison", "result.json");
    await writeFile(join(runDir, "inbox", "T-poison.json"), JSON.stringify(taskEnvelope("T-poison", "w1", worktree)));
    await mkdir(join(runDir, "outbox", "w1", "T-poison"), { recursive: true });
    await writeFile(poisoned, JSON.stringify({ schema: "pifleet.result/v1", task_id: "T-poison", epoch: 1, worker: "w1", status: "success" }));
    await chmod(poisoned, 0o000);
    try {
      const r = await runCli(["artifacts", "--run", RUN_ID, "--all", "--json"]);
      expect(r.code).toBe(0);
      const payload = JSON.parse(r.stdout) as { tasks: Array<Record<string, unknown>> };
      const byId = new Map(payload.tasks.map((t) => [t["task_id"], t]));

      // `partial`, not `unavailable`: the repository facts WERE harvested and
      // only the envelope was refused, and conflating those would tell an
      // operator the whole task is unreadable when A2 is intact. The refusal
      // is named rather than silently dropped, which would read as "this task
      // simply produced no envelope".
      const poisonedTask = byId.get("T-poison");
      expect(poisonedTask?.["harvest_status"]).toBe("partial");
      expect(JSON.stringify(poisonedTask?.["reasons"])).toContain("could not be opened");

      // And the healthy task is intact, which is the actual regression: it
      // used to vanish along with the whole payload.
      expect(byId.get("T-1")?.["harvest_status"]).toBe("complete");
      expect(byId.get("T-1")?.["verdict"]).toBe("success");
    } finally {
      await chmod(poisoned, 0o644);
    }
  });

  test("naming neither --task nor --all is a usage error", async () => {
    const r = await runCli(["artifacts", "--run", RUN_ID, "--json"]);
    expect(r.code).toBe(2);
  });
});
