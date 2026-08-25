/**
 * That the exam's container is REACHED, and that the mount is proved before it
 * grades anything (ISC-233, ISC-277).
 *
 * `acceptance-container.test.ts` next door checks the argv. This file checks
 * the two things a correct argv cannot tell you, and they are the two things
 * that actually went wrong:
 *
 *  1. **Is it wired?** `AcceptanceContext.image` was the literal `null` from
 *     the day the module shipped, and the ISC-233 audit measured that mutating
 *     it to a plausible tag — an audit record naming a container that never
 *     ran — left 104 tests across four files green. Nothing read the field.
 *     Both arms are read back here.
 *
 *  2. **Is the mount proved FIRST?** This is ISC-277, and it is the reason the
 *     two criteria could not be sequenced the other way round. On macOS the
 *     daemon runs in a VM sharing a declared set of host directories, and `-v`
 *     against a path outside that set does NOT fail — it mounts an empty
 *     directory. A containerized exam over an unshared root finds no tests to
 *     fail, exits 0, and records `passed`: a green exam against nothing, with
 *     every symptom pointing at the worker. Strictly worse than the host-side
 *     clone it replaces.
 *
 * No Docker anywhere in this file. The refusal path is reached by injecting an
 * exec that answers the visibility question with NO, which is exactly the
 * differential the criterion asks for ("point the run at a deliberately
 * unshared root and assert the verdict is `unknown` with the mount named") and
 * is the one shape a real daemon cannot be made to produce on demand — a Linux
 * runner shares everything, so there is no unshared path to point at.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { resolveFromEnvelope, runAcceptance } from "../../src/harvest/acceptance.ts";
import { adjudicate } from "../../src/harvest/adjudicate.ts";
import { DerivedFactsSchema } from "../../src/contracts.ts";
import { Deadline } from "../../src/util/clock.ts";
import type { Exec, ExecResult } from "../../src/container/run.ts";
import { stripComments } from "../support/source-structure.ts";

const IMAGE = "pifleet/pi-worker:verify";

let repo: string;
let scratch: string;
let head: string;
const cleanups: string[] = [];

async function git(cwd: string, ...args: string[]): Promise<string> {
  const p = Bun.spawn(["git", ...args], {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@e", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@e" },
  });
  const [code, out, err] = await Promise.all([p.exited, new Response(p.stdout).text(), new Response(p.stderr).text()]);
  if (code !== 0) throw new Error(`git ${args.join(" ")}: ${err || out}`);
  return out.trim();
}

beforeAll(async () => {
  repo = await mkdtemp(join(tmpdir(), "pifleet-wire-repo-"));
  scratch = await mkdtemp(join(tmpdir(), "pifleet-wire-scratch-"));
  cleanups.push(repo, scratch);
  await git(repo, "init", "--quiet", "-b", "main");
  await writeFile(join(repo, "data.txt"), "needle\n");
  await git(repo, "add", "-A");
  await git(repo, "commit", "--quiet", "-m", "base");
  head = await git(repo, "rev-parse", "HEAD");
});

afterAll(async () => {
  for (const d of cleanups) await rm(d, { recursive: true, force: true });
});

/**
 * An exec that mounts fine and reads back NOTHING — the "silently empty" case.
 *
 * `probeMountVisibility` writes a sentinel and then `cat`s it inside a
 * container. A daemon serving an unshared path answers with an empty file and
 * exit 0 from `cat`'s point of view or a "No such file" and non-zero; either
 * way the TOKEN is absent, and absence of the token is the whole test. Exit 0
 * with empty stdout is modelled here deliberately, because it is the reading
 * that looks most like success.
 */
function unsharedRootExec(calls: string[][]): Exec {
  return async (argv): Promise<ExecResult> => {
    calls.push([...argv]);
    return { code: 0, stdout: "", stderr: "", timedOut: false };
  };
}

/** The same probe answering YES, so the contrast is a one-field change. */
function sharedRootExec(calls: string[][]): Exec {
  return async (argv): Promise<ExecResult> => {
    calls.push([...argv]);
    return { code: 0, stdout: "pifleet-mount-ok\n", stderr: "", timedOut: false };
  };
}

const COMMANDS = resolveFromEnvelope(["touch /tmp/pifleet-should-not-exist"], "0".repeat(40));

describe("the mount is proved before the exam is held (ISC-277)", () => {
  test("an unshared scratch root yields not_run, and names the mount", async () => {
    const calls: string[][] = [];
    const r = await runAcceptance({
      repo,
      head_sha: head,
      scratch_dir: scratch,
      commands: COMMANDS,
      deadline: new Deadline(60_000),
      per_command_timeout_ms: 10_000,
      container: { image: IMAGE, probeExec: unsharedRootExec(calls) },
    });

    expect(r.runs).toHaveLength(1);
    expect(r.runs[0]!.outcome).toBe("not_run");
    // The diagnosis has to name the CAUSE, not the symptom. "acceptance did
    // not run" sends the reader to the worker; naming the daemon's view of the
    // path sends them to the mount, which is where the fault is.
    expect(r.runs[0]!.excerpt).toContain("ISC-277");
    expect(r.runs[0]!.excerpt).toContain("EMPTY");
    expect(r.runs[0]!.excerpt).toMatch(/Docker daemon/);
  });

  test("the probe really ran, against the scratch root, in the worker's image", async () => {
    const calls: string[][] = [];
    await runAcceptance({
      repo,
      head_sha: head,
      scratch_dir: scratch,
      commands: COMMANDS,
      deadline: new Deadline(60_000),
      per_command_timeout_ms: 10_000,
      container: { image: IMAGE, probeExec: unsharedRootExec(calls) },
    });
    expect(calls).toHaveLength(1);
    const argv = calls[0]!;
    expect(argv[0]).toBe("docker");
    // The SCRATCH ROOT, not the clone: sharing is by path prefix, and probing
    // the clone would mean writing a sentinel into the tree under examination.
    expect(argv.some((a) => a === `${scratch}:/probe:ro`)).toBe(true);
    expect(argv).toContain(IMAGE);
  });

  /**
   * The half that makes the refusal worth having.
   *
   * A `not_run` that arrived AFTER the commands ran would be a cosmetic
   * verdict over a real execution — and on the failure this criterion is about,
   * that execution is a green exam against an empty directory. The command is
   * chosen so that running it leaves a trace on the filesystem: if the trace
   * exists, the gate fired too late.
   */
  test("no acceptance command executes when the probe says no", async () => {
    const witness = join(scratch, "did-run.txt");
    await rm(witness, { force: true });
    const r = await runAcceptance({
      repo,
      head_sha: head,
      scratch_dir: scratch,
      commands: resolveFromEnvelope([`touch ${witness}`], "0".repeat(40)),
      deadline: new Deadline(60_000),
      per_command_timeout_ms: 10_000,
      container: { image: IMAGE, probeExec: unsharedRootExec([]) },
    });
    expect(r.runs[0]!.outcome).toBe("not_run");
    expect(existsSync(witness)).toBe(false);
  });

  /**
   * The control. Same call, same fixture, ONE field different — the probe's
   * answer. Without it the three assertions above would also pass against a
   * runner that refuses unconditionally, which is a different bug wearing the
   * same green.
   */
  test("a visible root does NOT refuse: the run proceeds past the gate", async () => {
    const witness = join(scratch, "did-run-2.txt");
    await rm(witness, { force: true });
    const r = await runAcceptance({
      repo,
      head_sha: head,
      scratch_dir: scratch,
      commands: resolveFromEnvelope([`touch ${witness}`], "0".repeat(40)),
      deadline: new Deadline(60_000),
      per_command_timeout_ms: 30_000,
      container: { image: IMAGE, probeExec: sharedRootExec([]) },
    });
    // The command itself is a `docker run` that will not succeed on a machine
    // with no daemon or no image, so the OUTCOME is not what is asserted —
    // only that the runner got past the gate and produced a real attempt
    // rather than the ISC-277 refusal.
    expect(r.runs[0]!.excerpt).not.toContain("ISC-277");
  });

  test("an unshared root adjudicates to unknown, never to success", async () => {
    const r = await runAcceptance({
      repo,
      head_sha: head,
      scratch_dir: scratch,
      commands: COMMANDS,
      deadline: new Deadline(60_000),
      per_command_timeout_ms: 10_000,
      container: { image: IMAGE, probeExec: unsharedRootExec([]) },
    });
    const facts = DerivedFactsSchema.parse({
      branch: "fleet/run-1/eng-1",
      base_ref: "0".repeat(40),
      head_ref: head,
      base_is_ancestor: true,
      commits: [],
      files_changed: [{ path: "data.txt", change: "modified" }],
      diff_bytes: 12,
      acceptance: r.runs,
      acceptance_context: r.context,
      harness: { patterns: [], touched: [] },
      tree_hash_quiesce: "tree-1",
      tree_hash_harvest: "tree-1",
    });
    const verdict = adjudicate(facts, null);
    expect(verdict.verdict).not.toBe("success");
    expect(verdict.verdict).toBe("unknown");
  });
});

describe("the audit record names the image that graded the code (ISC-233)", () => {
  test("the container arm records the tag", async () => {
    const r = await runAcceptance({
      repo,
      head_sha: head,
      scratch_dir: scratch,
      commands: COMMANDS,
      deadline: new Deadline(60_000),
      per_command_timeout_ms: 10_000,
      container: { image: IMAGE, probeExec: unsharedRootExec([]) },
    });
    expect(r.context.image).toBe(IMAGE);
  });

  test("the host arm records null, which is a real answer and not a placeholder", async () => {
    // `null` means the run had no container at all — `PIFLEET_PI_COMMAND`,
    // which is how this repo's whole e2e suite runs. Asserting BOTH arms is
    // what makes the field's value evidence: a mutation that hard-codes either
    // one turns exactly one of these two red.
    const r = await runAcceptance({
      repo,
      head_sha: head,
      scratch_dir: scratch,
      commands: resolveFromEnvelope(["true"], "0".repeat(40)),
      deadline: new Deadline(60_000),
      per_command_timeout_ms: 10_000,
    });
    expect(r.context.image).toBeNull();
    expect(r.runs[0]!.outcome).toBe("passed");
  });
});

/**
 * The `grep`-for-the-caller check, applied to source rather than to behaviour.
 *
 * `feedback_agents_stall_at_mutation_proofs` states the rule this enforces:
 * when the deliverable is "a thing that runs", the acceptance test is a grep
 * for its CALLER, not the suite that exercises it directly. Comment-stripped,
 * because a module that explains in prose why it uses something passes a naive
 * grep long after the call is gone — the trap `session-presence-consumers`
 * fell into with `dispatch.ts`.
 */
describe("the container path is reached from production, not only from tests", () => {
  test("acceptance.ts calls the argv builder", async () => {
    const src = stripComments(await readFile("src/harvest/acceptance.ts", "utf8"));
    expect(src).toContain("acceptanceContainerArgv(");
    expect(src).toContain("acceptanceContainerEnv(");
    expect(src).toContain("probeMountVisibility(");
  });

  test("harvest/index.ts passes an image resolved from the run's own launch record", async () => {
    const src = stripComments(await readFile("src/harvest/index.ts", "utf8"));
    expect(src).toContain("readWorkerLaunch(");
    expect(src).toContain("networkFromLaunchArgv(");
    expect(src).toMatch(/container:/);
  });

  /**
   * ISC-277's other half, and the one a behavioural test cannot reach: the
   * default scratch root. `container/mounts.ts` marks `os.tmpdir()`
   * "Deliberately NOT" — measured on this machine as "not shared, silently
   * empty" — and the acceptance path used exactly it.
   */
  test("the acceptance scratch root is no longer os.tmpdir()", async () => {
    const src = stripComments(await readFile("src/harvest/index.ts", "utf8"));
    expect(src).toContain("makeDaemonScratch(");
    expect(src).not.toContain("tmpdir()");
  });

  /**
   * The obligation the move CREATED, and it is not optional.
   *
   * Nothing ever removed the old `mkdtemp(tmpdir())` root either, which was
   * survivable only because the OS reaps its temp directory. Under
   * `$HOME/.pifleet/scratch` the identical leak is permanent — a full clone of
   * the repository per `artifacts --run-acceptance`, forever. Six of them
   * accumulated on this machine during one afternoon of building the feature,
   * which is how it was noticed at all.
   *
   * Guarded on `ownScratch`, because a caller-supplied root is the caller's:
   * removing it would be tidying state this function did not create.
   */
  test("a scratch root this function allocated is removed again", async () => {
    const src = stripComments(await readFile("src/harvest/index.ts", "utf8"));
    expect(src).toContain("ownScratch");
    expect(src).toMatch(/finally\s*\{/);
    expect(src).toMatch(/if \(ownScratch\) await rm\(scratchRoot/);
  });

  /**
   * The container name, checked at the CALL SITE rather than in the builder.
   *
   * `acceptance-container.test.ts` proves the argv carries `--name`; only this
   * proves the runner reaps by it. `--rm` is a client-side action, so a
   * SIGKILLed docker client leaves the container running — measured on this
   * feature's own `timed_out` probe, which left a `sleep 60` container `Up`
   * after its run had been recorded and returned.
   */
  test("a timed-out exam reaps its container by name", async () => {
    const src = stripComments(await readFile("src/harvest/acceptance.ts", "utf8"));
    expect(src).toContain("acceptanceContainerName(");
    expect(src).toMatch(/if \(cr\.timedOut\) await reapAcceptanceContainer\(/);
  });
});
