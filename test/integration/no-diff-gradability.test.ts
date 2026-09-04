/**
 * A task that changed nothing, graded on evidence the worker could not author
 * (SRD-REVIEW-CONSOLE §2.6 Findings A and D, D9).
 *
 * ## Why this file exists at all
 *
 * `ddf8b16` ("Harvest: an empty diff with green acceptance is not fabrication")
 * amended ISC-93 so that `success` behind an empty diff is exempt from the
 * fabrication verdict WHEN the harvester's own re-run of the acceptance
 * commands came back green. The amendment is correct and it was never
 * exercised: SRD-REVIEW-CONSOLE §2.6 Finding D records that at the time of
 * writing **the repository contained no working example of the exemption** —
 * `grep` found the branch, the docblock and the reason string, and nothing
 * that had ever taken the arm. A criterion whose mechanism has never executed
 * is a claim, not a test, and a claim is exactly what a mutation survives.
 *
 * The live demo on 2026-09-04 is the shape of the problem. A tester ran
 * rally-cli's suite to `.venv/bin/pytest -q -> exit 0, 1120 passed`, reported
 * success, changed nothing because nothing needed changing — and the harvest
 * came back `failed` with `no acceptance commands were run`. The exemption
 * could not fire because the exam was never held.
 *
 * So the first block below builds the fixture Finding D asks for, verbatim:
 * *"a fixture task whose acceptance commands survive `tokenize` (no
 * metacharacters), run green in the fresh clone, and carry an empty diff to
 * `success`."* Nothing here is mocked. A real `git init`, real commits, a real
 * `git clone --no-hardlinks --no-checkout` into a scratch root outside the
 * worktree, and two real subprocesses whose exit codes decide the verdict.
 *
 * ## The controls are the point, and there are four of them
 *
 * A single green assertion on the exemption arm proves almost nothing: a
 * fixture that reached `success` for any other reason would satisfy it. Each
 * control below moves exactly one input and pins the verdict to a different
 * value, so the arm is measured as a MOVEMENT rather than asserted as a state.
 *
 *  - **No commands at all** → `failed`, with the 2026-09-04 reason verbatim.
 *    This is the demo's own result, reproduced, and it is what the exemption
 *    is being distinguished from.
 *  - **A red command** → `failed`, but naming the failed exit rather than
 *    ISC-93. The exemption must not launder a suite that went red.
 *  - **Finding D's own counter-example** — `Docs/SRD.md`'s
 *    `kasa status --json | jq -e .devices exits 0` — → `not_run` and `failed`.
 *    A pipe never reaches a process, and a command that never ran cannot
 *    exempt anything.
 *  - **The runs themselves**, read back out of the fact bundle: `passed`,
 *    resolved from the BASE sha, in a clone path outside the worktree. Without
 *    these the green verdict could be coming from anywhere.
 *
 * A future edit that softens `tokenize`, or that lets the exemption fire on
 * `not_run`/`timed_out`, turns one of those four red. That is the whole design,
 * and it was MEASURED rather than asserted — two mutations, applied to a
 * throwaway clone, each killing exactly the probe that names it:
 *
 *   - `adjudicate.ts:232`, `if (acceptance.verdict === "success")` → `if
 *     (false)`: the exemption arm switched off. Only "green harvester-run
 *     acceptance carries an empty diff to success" went red. The other four
 *     tests in this block stayed green, which is what makes them controls
 *     rather than duplicates.
 *   - `acceptance.ts:428`, `META` emptied so `tokenize` accepts every
 *     metacharacter: only "a command carrying a shell metacharacter is
 *     not_run" went red. That is the tempting wrong fix — pass metacharacters
 *     through as literal argv — caught by the one probe written for it.
 *
 * ## Why the acceptance commands look the way they do
 *
 * `tokenize` refuses `| & ; < > ` $ ( ) \ * ? ~` outside quotes and says why:
 * *"no shell is ever invoked; commit a script at the base SHA instead"*
 * (`acceptance.ts:457`). The fixture takes that advice literally — the shell
 * lives INSIDE `acceptance/check-inventory.sh`, which is committed at the base
 * sha, and the command string that names it is three metacharacter-free words.
 * The second command is a bare argv with no script at all, so both admissible
 * forms are exercised.
 *
 * It is invoked as `sh acceptance/check-inventory.sh` rather than
 * `./acceptance/check-inventory.sh` deliberately. `execBounded` spawns argv
 * with `cwd` set to the fresh clone and a hermetic `PATH` that has no `.` in
 * it; resolving a relative argv[0] against the cwd is a property of the
 * spawner, not of this repo, and pinning the fixture to it would make the
 * exemption's working example depend on something no criterion states.
 * Naming `sh` — which the hermetic PATH does cover, at `/bin/sh` — removes the
 * question, and removes any dependence on the exec bit surviving git.
 *
 * ## The second block was written to FAIL, and the failure was measured
 *
 * SRD-REVIEW-CONSOLE §12.1 states it plainly for this criterion: *"A
 * `shared-ro` worker's result is gradable… **this criterion fails before the
 * fix and is the one that proves Finding A was real.**"* The fix is Finding
 * B's one-line repair — gating ISC-93's empty-diff check on `facts.repository`
 * exactly as ISC-151's clamp beside it already is — and it landed alongside
 * this file rather than before it.
 *
 * So the differential was taken rather than predicted. This file was run
 * against `0dafd45`, the last commit BEFORE the gate, in an isolated clone.
 * Result: **eight pass, one fail** — the last test in this block, and only it.
 * Its harvest came back:
 *
 *     VERDICT: failed
 *     - task has no host_workdir: not repository work, graded on its result
 *       envelope and artifacts
 *     - no acceptance commands were run
 *     - envelope claims success with an empty diff and no commits (ISC-93).
 *       If this task was not meant to change files, give it acceptance
 *       commands — the harvester re-runs those itself and they are what makes
 *       a no-diff task gradable
 *
 * That is Finding A's four links, end to end, producing the fabrication
 * verdict on an honest review — and Finding C in the same three lines, since
 * the remedy the reason offers is the one a `shared-ro` worker structurally
 * cannot take. The three chain tests above it passed on BOTH sides of the
 * gate, which is what makes the ninth a movement rather than a coincidence.
 *
 * Do NOT weaken it to green if it ever goes red again. The chain assertions
 * are separate tests precisely so that exactly one thing fails and the other
 * three keep naming which link broke: `isolation: shared-ro` → no worktree →
 * `host_workdir: "unset"` → acceptance not run.
 *
 * ## What is real in the second block and what is a double
 *
 * REAL: `loadConfig` and `resolveWorker` over a real `fleet.yaml`,
 * `createWorkerWorktrees` (which is what decides a `shared-ro` worker gets no
 * checkout), the run record, `sendTaskEnvelope` — THE dispatch path — the
 * control socket and its auth, the inbox write, and the whole harvest.
 *
 * A DOUBLE: only the supervisor's `dispatch` verb, a socket server that
 * answers with an epoch. Same seam and same reasoning as
 * `staged-harvest.test.ts`, including its rule that the allocated epoch is
 * deliberately NOT 1 — a worker's first task allocates 1, so a fixture using 1
 * agrees with a hard-coded default by coincidence.
 *
 * NOT PRESENT: any container. Neither block writes a `launch.json`, so
 * `readWorkerLaunch` returns null, `planDispatch` routes rpc, and the
 * acceptance exam takes the host path. A Docker daemon is not required to run
 * this file.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { stringify } from "yaml";

import { loadConfig, resolveWorker } from "../../src/config/load.ts";
import { attemptIdFor, sendTaskEnvelope } from "../../src/cli/commands/dispatch.ts";
import { harvestTask } from "../../src/harvest/index.ts";
import { LedgerWriter } from "../../src/run/ledger.ts";
import {
  inboxTaskPath,
  runPaths,
  workerOutboxDir,
  workerPaths,
  type RunPaths,
} from "../../src/run/paths.ts";
import { serveJsonlSocket } from "../../src/run/registry.ts";
import { createWorkerWorktrees } from "../../src/run/worktree.ts";
import { ensureControlAuth, loadControlSecret } from "../../src/security/control-auth.ts";
import { opsBudget } from "../support/budget.ts";

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

async function sh(argv: string[], cwd: string): Promise<string> {
  const p = Bun.spawn(argv, { cwd, stdout: "pipe", stderr: "pipe" });
  const out = await new Response(p.stdout).text();
  if ((await p.exited) !== 0) {
    throw new Error(`${argv.join(" ")} failed: ${await new Response(p.stderr).text()}`);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Block 1 — the ISC-93 exemption, exercised end to end (Finding D)
// ---------------------------------------------------------------------------

const EXEMPT_RUN = "r-isc93-exempt";
const EXEMPT_WORKER = "tst-1";

/**
 * The inspection task's own subject matter, committed at the base sha.
 *
 * `INVENTORY.md` already agrees with `services.txt`, which is what makes the
 * honest answer "nothing needed changing" and the honest diff empty. The
 * acceptance script re-derives that agreement from scratch, so a green run is
 * a statement about the tree rather than about the worker.
 */
const SERVICES = ["alpha", "beta", "gamma"];

/**
 * The remedy `tokenize`'s refusal message names, made real.
 *
 * Every shell construct this check needs — a loop, a variable, word splitting
 * — lives in this file, at the base sha, where the worker's branch cannot
 * reach it. The COMMAND STRING that runs it is metacharacter-free, which is
 * the property Finding D says nothing in this repository had ever
 * demonstrated.
 */
const CHECK_SCRIPT = `#!/bin/sh
# Committed at the base SHA. The harvester resolves the command string that
# names this file from the base SHA too, so a worker that rewrites either one
# on its own branch changes nothing about what is executed here.
set -eu
for name in $(cat services.txt); do
  grep -q -F "$name" INVENTORY.md
done
`;

/** Runs the committed script. Three words, none of them a metacharacter. */
const CMD_SCRIPT = "sh acceptance/check-inventory.sh";
/** The other admissible form: a bare argv, no script, no shell. */
const CMD_ARGV = "grep -q -F gamma INVENTORY.md";
/** Same shape, but the tree does not contain it: exit 1, a real red. */
const CMD_RED = "grep -q -F delta INVENTORY.md";
/**
 * `Docs/SRD.md:1239`'s own example, quoted verbatim by Finding D as a command
 * this repository documents and cannot run. The `|` is refused by `tokenize`
 * before anything spawns.
 */
const CMD_FINDING_D = "kasa status --json | jq -e .devices exits 0";

interface ExemptFixture {
  run: RunPaths;
  repo: string;
  scratch: string;
  base: string;
}

/**
 * A run whose single task changed NOTHING — head is the base commit — and
 * whose worker claims `success` with an empty `files_changed`.
 *
 * The empty diff is structural rather than arranged: `base_ref` is the sha of
 * HEAD, so `git diff base...HEAD` and `git log base..HEAD` are empty by
 * construction and `diff_bytes` is 0. A fixture that instead committed a
 * change and then reverted it would carry commits, and `emptyDiff` in
 * `adjudicate.ts` requires all three to be empty at once.
 *
 * No `launch.json` is written: `readWorkerLaunch` returns null, so the exam
 * runs as host processes and no Docker daemon is involved.
 */
async function exemptFixture(acceptance: readonly string[]): Promise<ExemptFixture> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-isc93-exempt-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));

  const repo = join(root, "repo");
  await mkdir(join(repo, "acceptance"), { recursive: true });
  await sh(["git", "init", "-q", "-b", "main"], repo);
  await sh(["git", "config", "user.email", "fixture@example.test"], repo);
  await sh(["git", "config", "user.name", "fixture"], repo);
  await writeFile(join(repo, "services.txt"), `${SERVICES.join("\n")}\n`);
  await writeFile(
    join(repo, "INVENTORY.md"),
    `# Inventory\n\n${SERVICES.map((s) => `- ${s}\n`).join("")}`,
  );
  await writeFile(join(repo, "acceptance", "check-inventory.sh"), CHECK_SCRIPT);
  await sh(["git", "add", "-A"], repo);
  await sh(["git", "commit", "-qm", "base: the inventory and the check that reads it"], repo);
  const base = (await sh(["git", "rev-parse", "HEAD"], repo)).trim();

  /**
   * The scratch root is a SIBLING of the repo, never a child (ISC-149).
   *
   * `runAcceptance` refuses a `scratch_dir` inside the worktree outright, so a
   * fixture that nested them would fail before a single command ran — and it
   * would fail with a message about the spec rather than about the exemption,
   * which is the sort of green-for-the-wrong-reason this file is built to
   * avoid. Supplied explicitly rather than defaulted so the harvest touches
   * nothing under `$HOME/.pifleet/scratch`; `harvestTask` only removes a
   * scratch root it allocated itself, so this one is cleaned up here.
   */
  const scratch = join(root, "scratch");
  await mkdir(scratch, { recursive: true });

  const run = runPaths(EXEMPT_RUN, join(root, "runs"));
  await mkdir(run.inboxDir, { recursive: true });
  await writeFile(
    join(run.inboxDir, "T-inspect.json"),
    JSON.stringify({
      schema: "pifleet.task/v1",
      task_id: "T-inspect",
      run_id: EXEMPT_RUN,
      epoch: 1,
      attempt: 1,
      worker: EXEMPT_WORKER,
      dispatched_at: new Date().toISOString(),
      title: "T-inspect",
      brief: "confirm INVENTORY.md still lists every service in services.txt",
      repo,
      host_workdir: repo,
      container_workdir: "/workspace",
      branch: "main",
      base_ref: base,
      acceptance: [...acceptance],
      outbox: "/outbox/T-inspect",
      deadline_s: 1500,
    }),
  );

  const taskOutbox = join(workerOutboxDir(run.root, EXEMPT_WORKER), "T-inspect");
  await mkdir(taskOutbox, { recursive: true });
  await writeFile(
    join(taskOutbox, "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: "T-inspect",
      epoch: 1,
      worker: EXEMPT_WORKER,
      status: "success",
      summary: "inventory already agrees with services.txt; nothing needed changing",
      files_changed: [],
      commits: [],
      artifacts: [],
    }),
  );

  return { run, repo, scratch, base };
}

/** One harvest of the fixture, with the exam actually held. */
async function harvestExempt(acceptance: readonly string[]): Promise<{
  verdict: string;
  reasons: string[];
  runs: readonly { cmd: string; outcome: string; resolved_from: string }[];
  clonePath: string | null;
  repo: string;
  base: string;
}> {
  const f = await exemptFixture(acceptance);
  const { harvest, facts } = await harvestTask(f.run, "T-inspect", {
    runAcceptance: true,
    acceptanceScratch: f.scratch,
  });
  return {
    verdict: harvest.verdict,
    reasons: harvest.reasons,
    runs: facts.acceptance,
    clonePath: facts.acceptance_context?.clone_path ?? null,
    repo: f.repo,
    base: f.base,
  };
}

describe("the ISC-93 exemption has a working example (SRD-REVIEW-CONSOLE §2.6 Finding D)", () => {
  /**
   * THE CONTROL, and it runs first on purpose.
   *
   * This is the 2026-09-04 demo reproduced: an honest no-diff `success` with
   * no acceptance commands, graded as fabrication. Every assertion in the
   * green test below is a MOVEMENT away from this one. Without it, a fixture
   * that could never reach `failed` in the first place would satisfy the
   * exemption assertions for a reason unrelated to the exemption.
   *
   * `runAcceptance` is still ON here. The distinction being drawn is between
   * "the exam was offered and passed" and "there was no exam", not between
   * grading and not grading.
   */
  test(
    "with no acceptance commands, an empty diff behind success is still failed",
    async () => {
      const r = await harvestExempt([]);
      expect(r.verdict).toBe("failed");
      expect(r.reasons.join("\n")).toContain("no acceptance commands were run");
      expect(r.reasons.join("\n")).toContain(
        "envelope claims success with an empty diff and no commits (ISC-93)",
      );
    },
    opsBudget({ git: 24 }),
  );

  /**
   * THE EXEMPTION, taken. Finding D's probe, word for word.
   *
   * Two commands, both metacharacter-free, both green in a clone the worker
   * never touched, carrying an empty diff to `success` rather than `failed`.
   * The reason assertion names the arm rather than merely the verdict: a
   * future edit that reached `success` through the lattice's identity rule
   * instead — by, say, softening the else arm to `unknown` — would leave the
   * verdict right and this line red, which is the distinction that matters.
   */
  test(
    "green harvester-run acceptance carries an empty diff to success, naming the exemption",
    async () => {
      const r = await harvestExempt([CMD_SCRIPT, CMD_ARGV]);
      expect(r.verdict).toBe("success");
      const why = r.reasons.join("\n");
      expect(why).toContain("all 2 acceptance command(s) passed in the fresh clone");
      expect(why).toContain("this is a task whose product is not a change (ISC-93 not applied)");
      // …and NOT by way of the fabrication verdict it is exempt from.
      expect(why).not.toContain("(ISC-93). If this task");
    },
    opsBudget({ git: 24 }),
  );

  /**
   * The evidence behind the verdict above, read back out of the fact bundle.
   *
   * `passed` rather than `not_run` is what separates "the commands survived
   * `tokenize` and ran" from "the harvester declined to run them and the
   * verdict came from somewhere else" — and `not_run` is precisely how a
   * metacharacter failure presents, silently, with an excerpt nobody reads.
   * `resolved_from === base` pins ISC-148: a command resolved from HEAD would
   * be a command the worker could have authored.
   *
   * The clone-path assertion is ISC-149's, restated as a property of this run
   * rather than of the module: an exam held INSIDE the worktree grades files
   * the worker can still be writing.
   */
  test(
    "the commands really ran, from the base sha, in a clone outside the worktree",
    async () => {
      const r = await harvestExempt([CMD_SCRIPT, CMD_ARGV]);
      expect(r.runs.map((a) => a.cmd)).toEqual([CMD_SCRIPT, CMD_ARGV]);
      expect(r.runs.map((a) => a.outcome)).toEqual(["passed", "passed"]);
      for (const a of r.runs) expect(a.resolved_from).toBe(r.base);
      expect(r.clonePath).not.toBeNull();
      const rel = relative(r.repo, r.clonePath!);
      expect(rel.startsWith("..")).toBe(true);
    },
    opsBudget({ git: 24 }),
  );

  /**
   * The exemption does not launder a red suite.
   *
   * Same fixture, same empty diff, same `success` claim; one command that
   * exits 1. `acceptanceEvidence` returns `failed` before the ISC-93 branch is
   * reached, so the verdict is `failed` for the SUITE's reason and never
   * touches the exemption arm. An edit that made the arm fire on "any
   * acceptance at all" rather than on `verdict === "success"` turns this red.
   */
  test(
    "a red acceptance command fails for its own reason, not ISC-93's",
    async () => {
      const r = await harvestExempt([CMD_SCRIPT, CMD_RED]);
      expect(r.verdict).toBe("failed");
      const why = r.reasons.join("\n");
      expect(why).toContain("acceptance failed in the fresh clone");
      expect(why).toContain(CMD_RED);
      expect(why).not.toContain("ISC-93 not applied");
    },
    opsBudget({ git: 24 }),
  );

  /**
   * Finding D's counter-example, executed as a criterion rather than quoted.
   *
   * `Docs/SRD.md:1239` offers `kasa status --json | jq -e .devices exits 0` as
   * an acceptance command. It is not one: `tokenize` refuses the `|` outside
   * quotes, `runOne` maps the refusal to `not_run`, `acceptanceEvidence`
   * returns `unknown`, and the exemption's precondition is unmet — so the
   * documented example produces exactly the fabrication verdict the exemption
   * exists to prevent.
   *
   * This is the assertion that would go red if `tokenize` were ever softened
   * to "pass metacharacters through as literal argv", which is the tempting
   * fix and the wrong one: it would run something the author did not intend,
   * silently.
   */
  test(
    "a command carrying a shell metacharacter is not_run, and cannot exempt anything",
    async () => {
      const r = await harvestExempt([CMD_FINDING_D]);
      expect(r.runs.map((a) => a.outcome)).toEqual(["not_run"]);
      expect(r.runs[0]!.cmd).toBe(CMD_FINDING_D);
      const why = r.reasons.join("\n");
      expect(why).toContain("acceptance inconclusive");
      expect(why).toContain("envelope claims success with an empty diff and no commits (ISC-93)");
      expect(r.verdict).toBe("failed");
    },
    opsBudget({ git: 24 }),
  );
});

// ---------------------------------------------------------------------------
// Block 2 — a shared-ro worker's result is gradable (Finding A)
// ---------------------------------------------------------------------------

/**
 * `workerPaths().controlSock` hashes `(run_id, worker_id)` into the SHARED
 * `os.tmpdir()`, so two concurrent test processes with a fixed run id answer
 * each other's RPCs. Same idiom as `staged-harvest.test.ts`, same reason.
 */
const REVIEW_TAG = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const REVIEW_RUN = `ro-grade-${REVIEW_TAG}`;
const REVIEWER = "rev-1";
const REVIEW_TASK = "T-review";
/** Deliberately not 1 — see the file header. */
const ALLOCATED = 7;

let reviewRun: RunPaths;
let reviewRepo: string;
let reviewIsolation: string;
let createdWorktrees: readonly { workerId: string }[];
let dispatchCalls: Record<string, unknown>[] = [];

/**
 * The `fleet.yaml` the reviewer role actually has in this fleet.
 *
 * `isolation: shared-ro` on the `rev` role is copied from `fleet.yaml:434`,
 * which is what makes `rev-1` the worker Finding A names. The rest is the
 * minimum `loadConfig` accepts, kept deliberately close to
 * `render.test.ts`'s fixture so a schema change breaks both together rather
 * than leaving this one describing a shape the loader no longer allows.
 */
function reviewFleetYaml(): string {
  return stringify({
    version: 2,
    name: "ro-grade-fixture",
    docker: { pi_version: "0.79.6" },
    run: { repo: ".", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "DefaultModel", thinking: "medium" },
    defaults: { append_system_prompt_file: "./roles/common.md" },
    roles: {
      rev: {
        model: "DefaultModel",
        thinking: "high",
        tools: ["read", "grep", "find", "ls"],
        skills: ["pifleet-worker"],
        append_system_prompt_file: "./roles/rev.md",
        isolation: "shared-ro",
      },
    },
    workers: [{ id: REVIEWER, role: "rev" }],
  });
}

beforeAll(async () => {
  const root = await mkdtemp(join(tmpdir(), "pifleet-ro-grade-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));

  /**
   * The runs root is a SIBLING of the checkout, never a child of it (ISC-127).
   *
   * A `shared-ro` worker mounts `<repo>:/workspace:ro`, so a runs root inside
   * the repo would hand the reviewer `control-auth.json`, the ledger and every
   * other worker's state. `render.test.ts` records the same correction; this
   * fixture is not allowed to model the shape that one refuses.
   */
  reviewRepo = join(root, "repo");
  await mkdir(join(reviewRepo, "roles"), { recursive: true });
  await writeFile(join(reviewRepo, "roles", "common.md"), "Common fleet briefing.\n");
  await writeFile(join(reviewRepo, "roles", "rev.md"), "Reviewer role briefing.\n");
  await writeFile(join(reviewRepo, "fleet.yaml"), reviewFleetYaml());
  await sh(["git", "init", "-q", "-b", "main"], reviewRepo);
  await sh(["git", "config", "user.email", "fixture@example.test"], reviewRepo);
  await sh(["git", "config", "user.name", "fixture"], reviewRepo);
  await sh(["git", "add", "-A"], reviewRepo);
  await sh(["git", "commit", "-qm", "base"], reviewRepo);

  const loaded = await loadConfig(join(reviewRepo, "fleet.yaml"));
  reviewIsolation = resolveWorker(loaded, REVIEWER).isolation;

  reviewRun = runPaths(REVIEW_RUN, join(root, "runs"));
  await mkdir(reviewRun.inboxDir, { recursive: true });
  await mkdir(reviewRun.ledgerDir, { recursive: true });
  await mkdir(workerPaths(reviewRun, REVIEWER).dir, { recursive: true });

  /**
   * Link one of Finding A's chain, run for real rather than asserted.
   *
   * `createWorkerWorktrees` is the function that decides who gets a checkout,
   * and it filters on `resolveWorker(...).isolation === "worktree"`. Calling
   * it — instead of writing `worktrees: []` by hand — is what makes the
   * fixture a statement about the code rather than about the fixture author's
   * belief about the code.
   */
  createdWorktrees = await createWorkerWorktrees({
    loaded,
    run: reviewRun,
    repo: reviewRepo,
    workerIds: [REVIEWER],
  });

  /*
   * The run record `up` writes, with the list `createWorkerWorktrees` actually
   * returned — never a literal. `readRunWorktrees` is what `sendTaskEnvelope`
   * consults, and `[]` (not `null`) is the legitimate final state of a fleet
   * where no worker resolves to `worktree` isolation, per `up.ts:1917`.
   */
  await writeFile(
    reviewRun.runJson,
    JSON.stringify({
      run_id: REVIEW_RUN,
      repo: reviewRepo,
      branch_prefix: loaded.config.run.branch_prefix,
      worktrees: createdWorktrees,
    }),
  );

  await ensureControlAuth(reviewRun);
  const secret = await loadControlSecret(reviewRun);
  const server = await serveJsonlSocket(
    workerPaths(reviewRun, REVIEWER).controlSock,
    async (msg) => {
      dispatchCalls.push(msg);
      if (msg["cmd"] === "dispatch") {
        return { ok: true, accepted: true, epoch: ALLOCATED, replayed: false };
      }
      return { ok: false, error: `unexpected verb ${String(msg["cmd"])}` };
    },
    { secret },
  );
  cleanups.push(async () => server.stop());

  /*
   * THE DISPATCH PATH, real. No `launch.json` exists, so `planDispatch`
   * returns `rpc` and the envelope's `host_workdir` is filled by the same
   * `partial["host_workdir"] ?? wt?.path ?? "unset"` chain every live dispatch
   * uses (`dispatch.ts:786`). `partial` deliberately names no `host_workdir`:
   * an explicit one wins, and supplying it would be the fixture answering the
   * question the criterion is asking.
   */
  const partial: Record<string, unknown> = {
    task_id: REVIEW_TASK,
    title: REVIEW_TASK,
    brief: "review the diff on feature/x and report what you find",
    worker: REVIEWER,
  };
  await sendTaskEnvelope({
    run: reviewRun,
    worker: REVIEWER,
    taskId: REVIEW_TASK,
    partial,
    attemptId: attemptIdFor(JSON.stringify(partial)),
    requestedEpoch: null,
    ledger: new LedgerWriter(reviewRun, `test-${process.pid}`),
  });

  /*
   * An honest review: three real findings, no files touched, `success`. This
   * is the envelope SRD-REVIEW-CONSOLE §2.6 describes being graded as
   * fabrication — *"A reviewer that reads the code, finds three real defects,
   * writes a correct envelope and claims `success` is recorded as having
   * fabricated its work."*
   */
  const taskOutbox = join(workerOutboxDir(reviewRun.root, REVIEWER), REVIEW_TASK);
  await mkdir(taskOutbox, { recursive: true });
  await writeFile(
    join(taskOutbox, "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: REVIEW_TASK,
      epoch: ALLOCATED,
      worker: REVIEWER,
      status: "success",
      summary: "three findings, all with a path and a line; nothing to change here",
      files_changed: [],
      commits: [],
      artifacts: [],
    }),
  );
}, opsBudget({ git: 16, probe: 4 }));

describe("a shared-ro worker's result is gradable (SRD-REVIEW-CONSOLE §2.6 Finding A)", () => {
  test("the reviewer resolves to isolation: shared-ro, as fleet.yaml:434 has it", () => {
    expect(reviewIsolation).toBe("shared-ro");
  });

  test("so no worktree is created for it — link two of the chain", () => {
    expect(createdWorktrees.map((w) => w.workerId)).toEqual([]);
  });

  test(
    "and the dispatched envelope therefore carries host_workdir: unset — link three",
    async () => {
      const rec = JSON.parse(await readFile(inboxTaskPath(reviewRun, REVIEW_TASK), "utf8")) as {
        host_workdir: string;
        epoch: number;
      };
      expect(rec.host_workdir).toBe("unset");
      // The epoch came from the supervisor double, not from the CLI.
      expect(rec.epoch).toBe(ALLOCATED);
      expect(dispatchCalls.filter((m) => m["cmd"] === "dispatch").length).toBeGreaterThanOrEqual(1);
    },
    opsBudget({ probe: 2 }),
  );

  /**
   * THE CRITERION. Red at `0dafd45`, green with Finding B's gate — see the
   * file header for the verdict and reasons measured on the pre-gate tree.
   *
   * What happened before the gate, every link of it independently correct:
   * `hasWorktree` is false, so the harvester takes the no-workdir branch and
   * sets `repository: false`; acceptance cannot run without a worktree to
   * clone from (`harvest/index.ts:569`), so `facts.acceptance` stays empty;
   * `acceptanceEvidence` returns `unknown`; and ISC-93's branch saw `success`
   * behind an empty diff with acceptance that is not `success` and wrote
   * `derived = "failed"`. Every honest reviewer result in this fleet was
   * graded as fabrication.
   *
   * The one-line repair is Finding B's: gate that branch on `facts.repository`
   * exactly as ISC-151's clamp beside it already is (`adjudicate.ts:150`), on
   * the argument `harvest/index.ts:226-242` already makes at length — *"NO
   * WORKDIR IS A KIND OF TASK, NOT A DEGRADED HARVEST."*
   *
   * The assertion is deliberately `not.toBe("failed")` rather than an equality
   * against `success`. After the gate lands, `derived` is `unknown` and the
   * lattice's identity rule adopts the worker's claim — so the verdict is the
   * claim, whatever the claim was. Pinning `success` here would encode a
   * self-report as an expectation and would go red for the wrong reason on a
   * reviewer that honestly reported `partial`.
   *
   * The second assertion is the criterion's other half, from the same §12.1
   * probe: *"assert the reason names no diff at all."* A verdict that came out
   * right while still telling an operator their reviewer fabricated its work
   * has fixed the number and not the report.
   */
  test("its verdict is not `failed` merely because it has no worktree", async () => {
    const { harvest } = await harvestTask(reviewRun, REVIEW_TASK);
    expect(harvest.verdict).not.toBe("failed");
    expect(harvest.reasons.join("\n")).not.toContain(
      "envelope claims success with an empty diff and no commits (ISC-93)",
    );
  }, opsBudget({ probe: 4 }));
});
