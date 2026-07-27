/**
 * Acceptance independence against a real repository (ISC-148, 149, 152).
 *
 * The scenario is the one the ISA changelog records as "the single largest
 * correction to the SRD's §8.2 adjudication story": a worker owns its tree,
 * so re-running tests IN that tree — or resolving the command text FROM it —
 * grades the worker with the worker's own harness. Every test here seeds a
 * concrete attack (a sabotaged worktree, a doctored acceptance file, a lying
 * envelope, a harness edit) and asserts the production path is immune.
 *
 * Repository layout built in beforeAll:
 *
 *   main (base)  data.txt = "nothing here",  ACCEPTANCE = "grep -q needle data.txt"
 *   honest       data.txt = "the needle is here"          (does the task)
 *   cheat        ACCEPTANCE = "test -e ."                 (doctors the exam, skips the task)
 *   harness      does the task AND adds test/sneaky.test.ts (self-certifies)
 *
 * After setup the honest branch's WORKTREE is sabotaged (needle removed,
 * uncommitted) — the clone must not see it.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  DerivedFactsSchema,
  ResultEnvelopeSchema,
  type DerivedFacts,
  type FileChangeSchema,
} from "../../src/contracts.ts";
import { Deadline } from "../../src/util/clock.ts";
import {
  harnessSurface,
  resolveFromEnvelope,
  resolveFromTree,
  runAcceptance,
} from "../../src/harvest/acceptance.ts";
import { adjudicate } from "../../src/harvest/adjudicate.ts";
import type { z } from "zod";

const GIT_ENV = {
  PATH: "/usr/bin:/bin:/usr/local/bin:/opt/homebrew/bin",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_AUTHOR_NAME: "fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};

async function git(cwd: string, ...args: string[]): Promise<string> {
  const proc = Bun.spawn({
    cmd: ["git", ...args],
    cwd,
    env: { ...GIT_ENV, HOME: cwd },
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err, exit] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (exit !== 0) throw new Error(`git ${args.join(" ")} exited ${exit}: ${err}`);
  return out.trim();
}

let root: string;
let repo: string;
let scratch: string;
let baseSha: string;
let honestSha: string;
let cheatSha: string;
let harnessSha: string;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pifleet-accept-"));
  repo = join(root, "repo");
  scratch = join(root, "scratch");
  await mkdir(repo, { recursive: true });

  await git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "data.txt"), "nothing here\n");
  await writeFile(join(repo, "ACCEPTANCE"), "# done means the needle landed\ngrep -q needle data.txt\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "base");
  baseSha = await git(repo, "rev-parse", "HEAD");

  await git(repo, "checkout", "-q", "-b", "honest");
  await writeFile(join(repo, "data.txt"), "the needle is here\n");
  await git(repo, "commit", "-q", "-am", "do the task");
  honestSha = await git(repo, "rev-parse", "HEAD");

  await git(repo, "checkout", "-q", "main");
  await git(repo, "checkout", "-q", "-b", "cheat");
  await writeFile(join(repo, "ACCEPTANCE"), "test -e .\n");
  await git(repo, "commit", "-q", "-am", "adjust acceptance");
  cheatSha = await git(repo, "rev-parse", "HEAD");

  await git(repo, "checkout", "-q", "main");
  await git(repo, "checkout", "-q", "-b", "harness");
  await writeFile(join(repo, "data.txt"), "the needle is here\n");
  await mkdir(join(repo, "test"), { recursive: true });
  await writeFile(join(repo, "test", "sneaky.test.ts"), "// always green\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "-q", "-m", "do the task and edit the harness");
  harnessSha = await git(repo, "rev-parse", "HEAD");

  // Sabotage the WORKTREE (uncommitted): if any acceptance command executes
  // in — or resolves through — the worker's tree, the tests below flip.
  await git(repo, "checkout", "-q", "honest");
  await writeFile(join(repo, "data.txt"), "gone\n");
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

/** DerivedFacts from the REAL repository, the way a harvester would build them. */
async function factsFor(headSha: string, acceptance: DerivedFacts["acceptance"]): Promise<DerivedFacts> {
  const nameStatus = await git(repo, "diff", "--name-status", `${baseSha}...${headSha}`);
  const files: z.infer<typeof FileChangeSchema>[] = nameStatus
    .split("\n")
    .filter((l) => l.length > 0)
    .map((l) => {
      const [code, path] = l.split("\t") as [string, string];
      const change = code.startsWith("A") ? "added" : code.startsWith("D") ? "deleted" : "modified";
      return { path, change };
    });
  const commits = (await git(repo, "rev-list", `${baseSha}..${headSha}`)).split("\n").filter(Boolean);
  const diff = await git(repo, "diff", `${baseSha}...${headSha}`);
  return DerivedFactsSchema.parse({
    branch: "fleet/run-1/eng-1",
    base_ref: baseSha,
    head_ref: headSha,
    base_is_ancestor: true, // asserted for real in its own test below
    commits,
    files_changed: files,
    diff_bytes: Buffer.byteLength(diff),
    acceptance,
    acceptance_context: null,
    harness: harnessSurface(files.map((f) => f.path)),
    tree_hash_quiesce: "tree-1",
    tree_hash_harvest: "tree-1",
  });
}

describe("fresh-clone execution (ISC-149)", () => {
  // The clone-independence probe. The honest branch COMMITTED the needle and
  // the worktree then removed it (uncommitted). Fails if runAcceptance
  // executes in the worker's tree instead of a fresh clone by SHA — grep
  // would then miss the needle and the outcome would be failed.
  test("commands run against the committed SHA, not the (sabotaged) worktree", async () => {
    const { context, runs } = await runAcceptance({
      repo,
      head_sha: honestSha,
      scratch_dir: scratch,
      commands: resolveFromEnvelope(["grep -q needle data.txt"], baseSha),
      deadline: new Deadline(60_000),
      per_command_timeout_ms: 20_000,
    });
    expect(runs).toHaveLength(1);
    expect(runs[0]!.outcome).toBe("passed");
    expect(runs[0]!.exit_code).toBe(0);
    expect(runs[0]!.source).toBe("envelope");
    expect(runs[0]!.resolved_from).toBe(baseSha);
    // The audit record must say where and how this actually ran.
    expect(context.inherited_env).toBe(false);
    expect(context.clone_sha).toBe(honestSha);
    expect(context.clone_path.startsWith(resolve(scratch))).toBe(true);
    expect(context.clone_path.startsWith(resolve(repo))).toBe(false);
  });

  // The env-independence probe. POISON is set in THIS process; the command
  // passes only if the child does not see it. Fails if runAcceptance spreads
  // process.env into the child (the `...process.env` bug ISC-149 forbids).
  test("the child environment is built from scratch, not inherited", async () => {
    process.env["POISON"] = "leaked";
    try {
      const { runs } = await runAcceptance({
        repo,
        head_sha: honestSha,
        scratch_dir: scratch,
        commands: resolveFromEnvelope(["sh -c 'test -z \"$POISON\"'"], baseSha),
        deadline: new Deadline(60_000),
        per_command_timeout_ms: 20_000,
      });
      expect(runs[0]!.outcome).toBe("passed");
    } finally {
      delete process.env["POISON"];
    }
  });
});

describe("base-SHA command resolution (ISC-148)", () => {
  // The doctored-exam probe. The cheat branch rewrote ACCEPTANCE to an
  // always-pass command and never did the task. Resolution from the BASE SHA
  // must return the original exam, which the cheat head then fails. Fails if
  // resolveFromTree reads the head, the index, or the working tree — the
  // doctored `test -e .` would pass and the cheat would be graded success.
  test("a worker that rewrites the acceptance file is graded by the base's version", async () => {
    const fromBase = await resolveFromTree(repo, baseSha, "ACCEPTANCE");
    expect(fromBase).toEqual([
      { cmd: "grep -q needle data.txt", source: "tree", resolved_from: baseSha },
    ]);

    const { runs } = await runAcceptance({
      repo,
      head_sha: cheatSha,
      scratch_dir: scratch,
      commands: fromBase,
      deadline: new Deadline(60_000),
      per_command_timeout_ms: 20_000,
    });
    expect(runs[0]!.outcome).toBe("failed");
    expect(runs[0]!.exit_code).toBe(1);

    // Full circle: those facts adjudicate to failed even with a glowing claim.
    const facts = await factsFor(cheatSha, runs);
    const verdict = adjudicate(facts, null);
    expect(verdict.verdict).toBe("failed");
  });

  // Demonstrates the mechanism distinguishes trees — resolution at the cheat
  // head DOES see the doctored file. This is the control that proves the
  // previous test's pass/fail difference comes from the SHA argument alone.
  test("resolution at the cheat head sees the doctored exam (the control)", async () => {
    const fromCheat = await resolveFromTree(repo, cheatSha, "ACCEPTANCE");
    expect(fromCheat).toEqual([{ cmd: "test -e .", source: "tree", resolved_from: cheatSha }]);
  });

  // ISC-151's ground truth on a real repo: base is an ancestor of every
  // branch head here. Fails if the fixture drifts into rewriting history,
  // which would silently invalidate every diff-based assertion above.
  test("base is an ancestor of each graded head", async () => {
    for (const sha of [honestSha, cheatSha, harnessSha]) {
      await git(repo, "merge-base", "--is-ancestor", baseSha, sha); // throws on nonzero
    }
  });
});

describe("timeouts and budget (ISC-152)", () => {
  // Fails if the runner waits for natural exit (this test would hang far past
  // its own timeout) or if timed_out is collapsed into failed anywhere from
  // outcome to verdict.
  test("a command that outlives its budget is timed_out and adjudicates unknown", async () => {
    const { runs } = await runAcceptance({
      repo,
      head_sha: honestSha,
      scratch_dir: scratch,
      commands: resolveFromEnvelope(["sleep 1000"], baseSha),
      deadline: new Deadline(60_000),
      per_command_timeout_ms: 250,
    });
    expect(runs[0]!.outcome).toBe("timed_out");
    expect(runs[0]!.exit_code).toBeNull();

    const facts = await factsFor(honestSha, runs);
    const verdict = adjudicate(facts, null);
    expect(verdict.verdict).toBe("unknown");
    expect(verdict.verdict).not.toBe("failed"); // ISC-152, stated as itself
  });

  // Fails if per-command timeouts stop being bounded by the run deadline —
  // an expired run budget must yield not_run without spawning anything.
  test("an exhausted run budget yields not_run", async () => {
    const { runs } = await runAcceptance({
      repo,
      head_sha: honestSha,
      scratch_dir: scratch,
      commands: resolveFromEnvelope(["grep -q needle data.txt"], baseSha),
      deadline: new Deadline(0),
      per_command_timeout_ms: 20_000,
    });
    expect(runs[0]!.outcome).toBe("not_run");
    expect(runs[0]!.excerpt).toContain("budget");
  });
});

describe("seeded disagreement and harness edits, end to end", () => {
  // ISC-92 against a real diff: the envelope claims a file no commit touched.
  // Fails if the file cross-check compares the envelope to itself or goes
  // soft (warning instead of F5 hard failure).
  test("a worker claiming a file it did not change is flagged and failed", async () => {
    const green = await runAcceptance({
      repo,
      head_sha: honestSha,
      scratch_dir: scratch,
      commands: resolveFromEnvelope(["grep -q needle data.txt"], baseSha),
      deadline: new Deadline(60_000),
      per_command_timeout_ms: 20_000,
    });
    const facts = await factsFor(honestSha, green.runs);
    const lying = ResultEnvelopeSchema.parse({
      schema: "pifleet.result/v1",
      task_id: "T-1",
      epoch: 1,
      worker: "eng-1",
      status: "success",
      files_changed: [
        { path: "data.txt", change: "modified" },
        { path: "src/ghost.ts", change: "added" },
      ],
      commits: [honestSha],
    });
    const got = adjudicate(facts, lying);
    expect(got.discrepancies.join("\n")).toContain("src/ghost.ts");
    expect(got.verdict).toBe("failed");
  });

  // ISC-150 end to end: the harness branch does the task (acceptance is
  // genuinely green in the fresh clone) AND edits test/sneaky.test.ts. The
  // control (honest) proves the pipeline yields success when the harness is
  // untouched, so this pair fails if harnessSurface stops matching real diff
  // paths OR the cap stops capping — and cannot pass vacuously, because the
  // harness fixture's touched[] is derived from the real diff, not written
  // by hand.
  test("a harness-touching diff caps a genuinely green run below success", async () => {
    const run = (sha: string) =>
      runAcceptance({
        repo,
        head_sha: sha,
        scratch_dir: scratch,
        commands: resolveFromEnvelope(["grep -q needle data.txt"], baseSha),
        deadline: new Deadline(60_000),
        per_command_timeout_ms: 20_000,
      });

    const control = await run(honestSha);
    const controlFacts = await factsFor(honestSha, control.runs);
    expect(controlFacts.harness.touched).toEqual([]);
    expect(adjudicate(controlFacts, null).verdict).toBe("success");

    const seeded = await run(harnessSha);
    expect(seeded.runs[0]!.outcome).toBe("passed"); // green — and still not success
    const seededFacts = await factsFor(harnessSha, seeded.runs);
    expect(seededFacts.harness.touched).toContain("test/sneaky.test.ts");
    const got = adjudicate(seededFacts, null);
    expect(got.verdict).not.toBe("success");
    expect(["blocked", "unknown"]).toContain(got.verdict);
  });
});
