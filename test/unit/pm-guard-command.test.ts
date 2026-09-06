/**
 * `pm-guard`'s own decisions, driven in-process (ISC-551, ISC-555, SRD §0.2).
 *
 * ## Why this file exists at all
 *
 * `test/unit/pm-guards.test.ts` already drives both judgements as pure
 * functions with injected data, which proves they are RIGHT. It does not touch
 * `src/cli/commands/pm-guard.ts`, and the coverage gate noticed: the command
 * module appeared in no report at all, because nothing in the suite imported
 * it. That is the same absence `test/unit/tui-command.test.ts` was written to
 * close, for the same reason — a module the profiler cannot see is a module
 * whose refusals nobody has ever executed.
 *
 * Importing a module to raise a number would be worthless, so this file is not
 * that. It asserts the three things the pure functions structurally CANNOT:
 *
 *   - **The exit-status trichotomy.** `confirmDispatchStarted` returns three
 *     states; the command turns them into three exit codes, and that mapping
 *     is the entire operational point of ISC-551. `staged` gets `TIMEOUT` and
 *     not `PARTIAL` on the argument in the command's own docstring — an
 *     attended dispatch is NORMAL, and a guard that reports normal operation
 *     as a failure is a guard an operator learns to ignore. Nothing but a
 *     process boundary can check that, because an exit code is the only thing
 *     the `&&` in the workflow's shell lines reads.
 *   - **`cloneContains`.** The pure function takes containment as a callback,
 *     so every existing test answers it from a `Map`. The real predicate
 *     shells out to `git merge-base --is-ancestor`, and its load-bearing
 *     behaviour — a non-zero exit is `false` and never a throw, which is the
 *     case where the clone predates the merge and does not have the object at
 *     all — is only observable against a real repository.
 *   - **The argument and fixture refusals** that happen BEFORE either
 *     judgement is reached: an unparseable `--phase`, an empty runs root, a
 *     run that records no clone for the named seat, an unreadable
 *     `--dispatch-output`. Each is a `USAGE` error, distinct from the
 *     `PARTIAL` a real refusal earns, because they tell the operator to fix
 *     the command line rather than the fleet.
 *
 * ## Why the fixtures are a real git repository and not a stub
 *
 * ISC-556 forbids a criterion requiring a real terminal, model or network. A
 * local `git init` is none of the three: it is the same instrument
 * `test/unit/pm-integration.test.ts` and the worktree suite already use, it
 * runs offline, and it is the only way to make the missing-object branch of
 * `cloneContains` happen rather than be described. The older clone here is
 * made BEFORE the second commit exists, so the merge commit is genuinely
 * absent from it — a `git clone` followed by `reset --hard` would leave the
 * object present and silently exercise the ancestry branch twice.
 */

import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../../src/cli/index.ts";
import { EXIT } from "../../src/contracts.ts";
import { register } from "../../src/cli/commands/pm-guard.ts";

const bases: string[] = [];

/**
 * `PIFLEET_RUNS_DIR` as it was BEFORE this file touched it, captured at module
 * load for the reason `tui-command.test.ts` sets out at length: `beforeEach`
 * overwrites it for every test here, `afterAll` deletes the directory it
 * points at, and bun's file order is `readdir()` order rather than anything
 * predictable — so leaving it dangling hands a deleted path to whichever file
 * happens to run next.
 */
const RUNS_DIR_BEFORE = process.env["PIFLEET_RUNS_DIR"];

afterAll(async () => {
  for (const base of bases) await rm(base, { recursive: true, force: true });
  if (RUNS_DIR_BEFORE === undefined) delete process.env["PIFLEET_RUNS_DIR"];
  else process.env["PIFLEET_RUNS_DIR"] = RUNS_DIR_BEFORE;
});

async function tempBase(prefix: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), prefix));
  bases.push(base);
  return base;
}

/**
 * Run `pm-guard <args>` and return whatever it threw, or `null` if it did not.
 *
 * A fresh `Command` per call, because commander accumulates parsed option
 * state on the command object — a shared program would let one case's
 * `--worker` satisfy the next case's required-option check.
 *
 * Stdout is captured rather than left to the terminal: what the command PRINTS
 * is half of its interface (the operator acts on the sentence, the shell acts
 * on the code), and a test that only read the exit status would pass against a
 * command that explained nothing.
 */
async function runGuard(args: string[]): Promise<{ err: unknown; out: string }> {
  const program = new Command();
  program.exitOverride();
  register(program);

  const written: string[] = [];
  const original = process.stdout.write.bind(process.stdout);
  process.stdout.write = ((chunk: string | Uint8Array) => {
    written.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    await program.parseAsync(["pm-guard", ...args], { from: "user" });
    return { err: null, out: written.join("") };
  } catch (err) {
    return { err, out: written.join("") };
  } finally {
    process.stdout.write = original;
  }
}

/** `runGuard`, asserting it refused, and handing back the CliError to inspect. */
async function refusal(args: string[]): Promise<CliError> {
  const { err } = await runGuard(args);
  expect(err, `pm-guard ${args.join(" ")} was expected to refuse, but returned`).toBeInstanceOf(
    CliError,
  );
  return err as CliError;
}

/* ────────────────────────────────────────────────────────────────────────────
 * dispatch-started — three states, three exit codes
 * ──────────────────────────────────────────────────────────────────────────── */

describe("dispatch-started turns three states into three exit codes", () => {
  let dir: string;
  let dispatchPath: string;
  let statusPath: string;

  beforeEach(async () => {
    dir = await tempBase("pifleet-pm-guard-cmd-");
    dispatchPath = join(dir, "dispatch.json");
    statusPath = join(dir, "status.json");
  });

  /** An envelope the fleet accepted — the `accepted: true` `dispatchProblem` looks for. */
  async function accepted(): Promise<void> {
    await writeFile(dispatchPath, JSON.stringify({ accepted: true, via: "staged" }), "utf8");
  }

  async function status(rows: unknown[]): Promise<void> {
    await writeFile(statusPath, JSON.stringify({ run_id: "r1", workers: rows }), "utf8");
  }

  const args = ["dispatch-started", "--worker", "eng-1", "--task", "T-1"];
  const paths = (): string[] => ["--dispatch-output", dispatchPath, "--status", statusPath];

  test("a worker holding the task exits SUCCESS and says so", async () => {
    await accepted();
    // A bystander alongside it: the guard must find its row by id, not by
    // taking whatever the first row happens to be.
    await status([
      { id: "eng-2", phase: "busy", task_id: "T-OTHER", staged_task_id: null },
      { id: "eng-1", phase: "busy", task_id: "T-1", staged_task_id: null },
    ]);

    const { err, out } = await runGuard([...args, ...paths()]);
    expect(err).toBeNull();
    expect(out).toContain("eng-1");
    expect(out).toContain("T-1");
  });

  /**
   * The distinction ISC-551 exists for. The envelope landed, the worker has
   * not started the turn, and the correct response is to LOOK AGAIN — not to
   * fix anything. `TIMEOUT` says that; `PARTIAL` would put an ordinary
   * attended dispatch in the same bucket as a broken one.
   */
  test("a task merely STAGED exits TIMEOUT, not PARTIAL", async () => {
    await accepted();
    await status([{ id: "eng-1", phase: "idle", task_id: null, staged_task_id: "T-1" }]);

    const err = await refusal([...args, ...paths()]);
    expect(err.exitCode).toBe(EXIT.TIMEOUT);
    expect(err.exitCode).not.toBe(EXIT.PARTIAL);
    expect(err.message).toMatch(/STAGED/);
  });

  /**
   * The failure the guard was built for: a dispatch that REPORTED success
   * which the fleet does not corroborate. `PARTIAL`, because something is
   * actually wrong and looking again will not fix it.
   */
  test("an accepted payload the fleet does not corroborate exits PARTIAL", async () => {
    await accepted();
    await status([{ id: "eng-1", phase: "idle", task_id: null, staged_task_id: null }]);

    const err = await refusal([...args, ...paths()]);
    expect(err.exitCode).toBe(EXIT.PARTIAL);
    expect(err.message).toContain("eng-1");
  });

  test("a dispatch that produced no output at all exits PARTIAL", async () => {
    // The empty string is the specific shape `dispatchProblem` names: what a
    // runner that discarded a failing exit status hands back.
    await writeFile(dispatchPath, "", "utf8");
    await status([{ id: "eng-1", phase: "busy", task_id: "T-1", staged_task_id: null }]);

    const err = await refusal([...args, ...paths()]);
    expect(err.exitCode).toBe(EXIT.PARTIAL);
    // Even though `status` says the worker holds T-1, the refusal wins: the
    // dispatch output is the evidence about the dispatch.
    expect(err.message).toMatch(/no output at all/);
  });

  /**
   * `--json` has to emit on EVERY branch, refusals included. A parser that
   * only received a verdict when the news was good would have to infer the
   * bad case from an exit code, which is exactly the inference the JSON exists
   * to remove.
   */
  test("--json emits a verdict on a refusal as well as on success", async () => {
    await accepted();
    await status([{ id: "eng-1", phase: "idle", task_id: null, staged_task_id: null }]);

    const { err, out } = await runGuard([...args, ...paths(), "--json"]);
    expect(err).toBeInstanceOf(CliError);
    const verdict = JSON.parse(out.trim()) as { state: string; started: boolean };
    expect(verdict.state).toBe("unconfirmed");
    expect(verdict.started).toBe(false);
  });

  test("an unreadable --dispatch-output is a USAGE error naming the path", async () => {
    const missing = join(dir, "nope.json");
    await status([{ id: "eng-1", phase: "busy", task_id: "T-1", staged_task_id: null }]);

    const err = await refusal([
      ...args,
      "--dispatch-output",
      missing,
      "--status",
      statusPath,
    ]);
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toContain(missing);
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * tester-fresh — against a real repository
 * ──────────────────────────────────────────────────────────────────────────── */

interface GitFixture {
  readonly repo: string;
  readonly baseSha: string;
  readonly mergeSha: string;
  readonly cloneOld: string;
  readonly cloneNew: string;
}

async function git(cwd: string, args: string[]): Promise<string> {
  const p = Bun.spawn(["git", "-C", cwd, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "pm-guard-test",
      GIT_AUTHOR_EMAIL: "pm-guard@example.invalid",
      GIT_COMMITTER_NAME: "pm-guard-test",
      GIT_COMMITTER_EMAIL: "pm-guard@example.invalid",
    },
  });
  const [out, errText, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  if (code !== 0) throw new Error(`git ${args.join(" ")} in ${cwd} failed: ${errText}`);
  return out.trim();
}

/**
 * A repository with two commits and two clones, one taken on either side of
 * the second.
 *
 * `cloneOld` is made while only the first commit exists, so the second commit
 * is not merely un-ancestral there — the object is ABSENT, which is the state
 * a tester's checkout is genuinely in when it predates the phase's integration
 * merge, and the state in which `git merge-base --is-ancestor` fails rather
 * than answering no.
 */
async function gitFixture(): Promise<GitFixture> {
  const base = await tempBase("pifleet-pm-guard-git-");
  const repo = join(base, "repo");
  await mkdir(repo, { recursive: true });
  await git(repo, ["init", "-b", "main"]);
  await writeFile(join(repo, "a.txt"), "a\n", "utf8");
  await git(repo, ["add", "a.txt"]);
  await git(repo, ["commit", "-m", "base"]);
  const baseSha = await git(repo, ["rev-parse", "HEAD"]);

  const cloneOld = join(base, "clone-old");
  await git(base, ["clone", "--quiet", repo, cloneOld]);

  await writeFile(join(repo, "b.txt"), "b\n", "utf8");
  await git(repo, ["add", "b.txt"]);
  await git(repo, ["commit", "-m", "the phase's integration merge"]);
  const mergeSha = await git(repo, ["rev-parse", "HEAD"]);

  const cloneNew = join(base, "clone-new");
  await git(base, ["clone", "--quiet", repo, cloneNew]);

  return { repo, baseSha, mergeSha, cloneOld, cloneNew };
}

/** A runs root holding one run whose `run.json` records the given checkouts. */
async function runsRootWith(
  runId: string,
  worktrees: Array<{ workerId: string; path: string; baseSha: string }>,
): Promise<string> {
  const base = await tempBase("pifleet-pm-guard-runs-");
  const root = join(base, "runs");
  await mkdir(join(root, runId), { recursive: true });
  await writeFile(
    join(root, runId, "run.json"),
    JSON.stringify({
      schema: "pifleet.run/v1",
      run_id: runId,
      worktrees: worktrees.map((w) => ({
        workerId: w.workerId,
        path: w.path,
        branch: `worker/${w.workerId}`,
        baseSha: w.baseSha,
        remoteName: `worker-${w.workerId}`,
      })),
    }),
    "utf8",
  );
  return root;
}

/**
 * The phase's integration record, in the repository where `--repo` will look
 * for it.
 *
 * The second row is deliberately a worker that did NOT merge. A phase where
 * every row merged cannot distinguish "only merged rows contribute" from "all
 * rows contribute", and a tester refused for a merge that never happened would
 * be refused for the rest of the phase with nothing to do about it. (The two
 * spellings of that filter — `merged` and a non-null `merge_commit` — are held
 * equal by the schema's own `superRefine`, which rejects a row carrying one
 * without the other, so no fixture can separate them.)
 */
async function writeIntegration(fx: GitFixture, phase: number, runId: string): Promise<void> {
  const dir = join(fx.repo, ".claude", "project-manager", `phase-${phase}`);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "integration.json"),
    JSON.stringify({
      schema: "pifleet.pmintegration/v1",
      run_id: runId,
      integration_branch: "feat/phase",
      base_sha: fx.baseSha,
      workers: [
        {
          worker: "eng-1",
          remote: "worker-eng-1",
          branch: "worker/eng-1",
          task_id: "T-1",
          head: fx.mergeSha,
          commits_ahead: 1,
          merged: true,
          merge_commit: fx.mergeSha,
        },
        {
          worker: "eng-2",
          remote: "worker-eng-2",
          branch: "worker/eng-2",
          task_id: "T-2",
          head: fx.baseSha,
          commits_ahead: 0,
          merged: false,
          merge_commit: null,
        },
      ],
    }),
    "utf8",
  );
}

describe("tester-fresh refuses before it reaches a judgement", () => {
  let root: string;

  beforeEach(async () => {
    root = await runsRootWith("2026-09-06T00-00-00Z-aaaa", []);
    process.env["PIFLEET_RUNS_DIR"] = root;
  });

  /**
   * `--phase` is parsed with `parseInt`, which happily reads `3x` as 3 and
   * hands back `NaN` for prose. Both have to refuse, and refuse naming the
   * flag: `integrationRecordPath(repo, NaN)` would otherwise go looking for
   * `phase-NaN` and report a missing file, sending the operator to look for a
   * record rather than at their own command line.
   */
  test("a --phase that is not a positive integer is a USAGE error naming the flag", async () => {
    for (const bad of ["0", "-1", "abc", ""]) {
      const err = await refusal(["tester-fresh", "--worker", "tst-1", "--phase", bad]);
      expect(err.exitCode).toBe(EXIT.USAGE);
      expect(err.message).toMatch(/--phase/);
    }
  });

  test("an empty runs root is 'no runs found', not a crash", async () => {
    const empty = await tempBase("pifleet-pm-guard-empty-");
    process.env["PIFLEET_RUNS_DIR"] = join(empty, "runs");
    await mkdir(join(empty, "runs"), { recursive: true });

    const err = await refusal(["tester-fresh", "--worker", "tst-1", "--phase", "1"]);
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toMatch(/no runs found/);
  });

  /**
   * A run that exists but records no checkout for this seat. The message has
   * to name what the run DOES hold: with a typo'd worker id and a run full of
   * clones, "no clone for tst-9" alone leaves the operator unable to tell a
   * misspelling from a seat that was never given one.
   */
  test("a seat with no recorded clone names the run and the seats that have one", async () => {
    const runId = "2026-09-06T01-00-00Z-bbbb";
    process.env["PIFLEET_RUNS_DIR"] = await runsRootWith(runId, [
      { workerId: "tst-1", path: "/nowhere", baseSha: "0".repeat(40) },
    ]);

    const err = await refusal(["tester-fresh", "--worker", "tst-9", "--phase", "1"]);
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toContain("tst-9");
    expect(err.message).toContain(runId);
    expect(err.message).toContain("tst-1");
  });
});

describe("tester-fresh asks git whether the clone really contains the merge", () => {
  let fx: GitFixture;
  const runId = "2026-09-06T02-00-00Z-cccc";

  beforeEach(async () => {
    fx = await gitFixture();
    await writeIntegration(fx, 1, runId);
  });

  afterEach(() => {
    if (RUNS_DIR_BEFORE === undefined) delete process.env["PIFLEET_RUNS_DIR"];
    else process.env["PIFLEET_RUNS_DIR"] = RUNS_DIR_BEFORE;
  });

  test("a clone taken after the merge passes", async () => {
    process.env["PIFLEET_RUNS_DIR"] = await runsRootWith(runId, [
      { workerId: "tst-1", path: fx.cloneNew, baseSha: fx.mergeSha },
    ]);

    const { err, out } = await runGuard([
      "tester-fresh",
      "--worker",
      "tst-1",
      "--phase",
      "1",
      "--repo",
      fx.repo,
    ]);
    expect(err).toBeNull();
    expect(out).toContain("tst-1");
  });

  /**
   * The alarming case, and the one that must not become a crash. `cloneOld`
   * does not have the merge commit as an OBJECT, so `git merge-base
   * --is-ancestor` exits non-zero having failed rather than having answered —
   * and the guard has to read that as "not contained", because refusing to
   * give an answer exactly when the answer is bad is the worst behaviour
   * available here.
   */
  test("a clone taken before the merge is refused, naming the commit it lacks", async () => {
    process.env["PIFLEET_RUNS_DIR"] = await runsRootWith(runId, [
      { workerId: "tst-1", path: fx.cloneOld, baseSha: fx.baseSha },
    ]);

    const err = await refusal([
      "tester-fresh",
      "--worker",
      "tst-1",
      "--phase",
      "1",
      "--repo",
      fx.repo,
    ]);
    expect(err.exitCode).toBe(EXIT.PARTIAL);
    expect(err.message).toContain(fx.mergeSha.slice(0, 12));
  });

  /**
   * The same two checkouts, through `--json`. A verdict a parser can read has
   * to carry the run and phase it was made about: a tester refused for phase 1
   * and a tester refused for phase 2 are different facts, and a bare
   * `{fresh: false}` would make a stale verdict indistinguishable from a
   * current one.
   */
  test("--json carries the run and phase the verdict was made about", async () => {
    process.env["PIFLEET_RUNS_DIR"] = await runsRootWith(runId, [
      { workerId: "tst-1", path: fx.cloneNew, baseSha: fx.mergeSha },
    ]);

    const { err, out } = await runGuard([
      "tester-fresh",
      "--worker",
      "tst-1",
      "--phase",
      "1",
      "--repo",
      fx.repo,
      "--json",
    ]);
    expect(err).toBeNull();
    const verdict = JSON.parse(out.trim()) as { run_id: string; phase: number; fresh: boolean };
    expect(verdict.run_id).toBe(runId);
    expect(verdict.phase).toBe(1);
    expect(verdict.fresh).toBe(true);
  });
});
