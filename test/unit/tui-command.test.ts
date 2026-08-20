/**
 * `tui`'s REFUSAL CONTRACT, driven in-process (ISC-22, SRD §3.5).
 *
 * ## Why this file exists at all
 *
 * `test/integration/tui.test.ts` covers this command end to end, but it does
 * so by spawning `src/cli/index.ts` as a SUBPROCESS. That is the right shape
 * for what it asserts — `#{pane_start_command}` is only observable against a
 * real tmux server — but it has a consequence that took a coverage report to
 * notice: the module under test is loaded in a child process, so
 * `src/cli/commands/tui.ts` never appears in `bun run test:coverage` at all.
 * It was one of three `src/` modules missing from the report, and the only one
 * whose absence was NOT structural (`backends/types.ts` is types-only and
 * `supervisor/index.ts` only ever runs as a spawned subprocess).
 *
 * Importing a module purely to raise a number would be worthless, so this file
 * is not that. It asserts the four refusals the integration suite does NOT
 * reach, because they all short-circuit before any pane, container or tmux
 * server is involved and a subprocess rig is the wrong instrument for them:
 *
 *   - `--worker` absent, and `--worker ""` (the `.trim()` branch)
 *   - no runs on disk at all
 *   - a worker with no `presentation.json`
 *   - a `headless` worker, which has no pane to hand over
 *
 * ## What these refusals are FOR
 *
 * All four are the same property from different directions: `tui` refuses
 * rather than pretending. The command's own docstring puts it plainly for the
 * headless case — "writing an attended record for a pane that cannot exist
 * would mark a run as human-touched when no hand could have touched it" — and
 * a run wrongly marked attended voids guarantees (ISC-87, ISC-106) that were
 * never actually voided. So every case here asserts BOTH halves: the ladder
 * code and message the operator gets, AND that no `attended.json` was left
 * behind. A refusal that still wrote the record would satisfy the first half
 * alone.
 *
 * The ladder codes are asserted as distinct values, not merely as "nonzero":
 * `EXIT.USAGE` tells a caller to fix its arguments and `EXIT.BACKEND_UNAVAILABLE`
 * tells it the machine cannot do this — collapsing the two would send an
 * orchestrator to rewrite a command line that was already correct.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CliError } from "../../src/cli/index.ts";
import { EXIT } from "../../src/contracts.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { register } from "../../src/cli/commands/tui.ts";

const bases: string[] = [];

/**
 * `PIFLEET_RUNS_DIR` as it was BEFORE this file touched it, captured at module
 * load — which is the only moment it is still the ambient value, since
 * `beforeEach` below overwrites it for every test in the file.
 *
 * Without the restore in `afterAll`, this file ends with the variable pointing
 * at a temp directory that `afterAll` has just DELETED, and leaves it that way
 * for the rest of the process. Measured: `undefined` at module load,
 * `…/pifleet-tui-unit-itcRr8/runs [DANGLING]` afterwards.
 *
 * ## Why "the other callers set it first" is not a defence
 *
 * It looked safe on the reasoning that every other `runsRoot()` caller sets the
 * variable itself before reading it, and that this file sorts after them
 * anyway. Both halves are wrong. **bun ignores CLI argument order** — measured,
 * `zzz aaa mmm` and `aaa mmm zzz` both execute `zzz, mmm, aaa` — so file order
 * is `readdir()` order, which is neither alphabetical nor argument order and
 * differs between APFS and a fresh Linux CI clone. This file runs 38th of 55
 * locally, with seventeen files downstream of it.
 *
 * ## The part that makes it survive
 *
 * `test/unit/render.test.ts` runs 51st and does the RIGHT thing: it captures
 * `PIFLEET_RUNS_DIR` at its own module load and restores that value in its
 * `afterAll`. But at position 51 the value it captures is already this file's
 * dangling path, so a correct save/restore idiom faithfully launders the
 * corruption forward. The leak persists precisely BECAUSE a neighbouring file
 * handles the variable properly — which is why fixing it at the source is the
 * only fix, and why a downstream assertion would not have caught it.
 *
 * Idiom copied deliberately from `render.test.ts` rather than invented, so the
 * suite has one shape for this and not two.
 */
const RUNS_DIR_BEFORE = process.env["PIFLEET_RUNS_DIR"];

afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
  // Restored AFTER the directories are gone: the variable must never be
  // observable pointing at a path this file has deleted.
  if (RUNS_DIR_BEFORE === undefined) delete process.env["PIFLEET_RUNS_DIR"];
  else process.env["PIFLEET_RUNS_DIR"] = RUNS_DIR_BEFORE;
});

async function tempRunsRoot(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-tui-unit-"));
  bases.push(base);
  const root = join(base, "runs");
  await mkdir(root, { recursive: true });
  return root;
}

/**
 * Run `tui` with `args` and return whatever it threw.
 *
 * A fresh `Command` per call, because commander accumulates parsed option
 * state on the command object and a shared program would let one case's
 * `--worker` leak into the next one's "no --worker" assertion.
 *
 * `exitOverride` keeps commander from calling `process.exit` and taking the
 * test runner with it; `from: "user"` means `args` is the argument list
 * itself rather than a full argv with two leading slots.
 */
async function runTui(args: string[]): Promise<unknown> {
  const program = new Command();
  program.exitOverride();
  register(program);
  try {
    await program.parseAsync(["tui", ...args], { from: "user" });
  } catch (err) {
    return err;
  }
  return null;
}

/** `runTui`, asserting it refused, and handing back the CliError for inspection. */
async function refusal(args: string[]): Promise<CliError> {
  const err = await runTui(args);
  expect(err, `tui ${args.join(" ")} was expected to refuse, but returned`).toBeInstanceOf(CliError);
  return err as CliError;
}

let root: string;
beforeEach(async () => {
  root = await tempRunsRoot();
  process.env["PIFLEET_RUNS_DIR"] = root;
});

describe("tui refuses without a worker to aim at", () => {
  test("no --worker at all is a usage error that names the flag", async () => {
    const err = await refusal([]);
    expect(err.exitCode).toBe(EXIT.USAGE);
    // The message has to name the missing flag; "invalid arguments" would
    // leave the operator to guess which of four options was wrong.
    expect(err.message).toMatch(/--worker/);
  });

  /**
   * `--worker ""` is a DIFFERENT input from an absent flag and reaches a
   * different branch (`opts.worker.trim() === ""`). Left unguarded it would
   * sail past the presence check and build `workerPaths(run, "")`, which
   * resolves to the run's own workers directory — so the failure would surface
   * as a confusing "no presentation record for worker " rather than as the
   * usage error it is.
   */
  test("an empty or whitespace --worker is refused the same way", async () => {
    for (const blank of ["", "   "]) {
      const err = await refusal(["--worker", blank]);
      expect(err.exitCode).toBe(EXIT.USAGE);
      expect(err.message).toMatch(/--worker/);
    }
  });
});

describe("tui refuses when there is nothing to attend", () => {
  test("an empty runs root is 'no runs found', not a crash", async () => {
    const err = await refusal(["--worker", "eng-1"]);
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toMatch(/no runs found/);
  });

  /**
   * A run that EXISTS but has no record for this worker. The message must name
   * both the worker and the run: with several runs on disk, "no presentation
   * record" alone does not tell the operator whether they typo'd the worker id
   * or are pointed at the wrong run.
   */
  test("a worker with no presentation record names both the worker and the run", async () => {
    const runId = "2026-08-19T00-00-00Z-unit1";
    const run = runPaths(runId, root);
    await mkdir(run.workersDir, { recursive: true });
    await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }), "utf8");

    const err = await refusal(["--worker", "eng-9"]);
    expect(err.exitCode).toBe(EXIT.USAGE);
    expect(err.message).toMatch(/no presentation record/);
    expect(err.message).toContain("eng-9");
    expect(err.message).toContain(runId);

    // Refusing wrote nothing: no attended record for a worker that has no pane.
    expect(await Bun.file(workerPaths(run, "eng-9").attendedJson).exists()).toBe(false);
  });
});

describe("a headless worker has no pane to hand over", () => {
  /**
   * The inverse lie to the one this subsystem exists to prevent. `headless`
   * has no pane at all, so "attending" it cannot mean anything — and marking
   * the run attended anyway would void ISC-87/ISC-106 guarantees that no human
   * was ever in a position to void.
   *
   * `EXIT.BACKEND_UNAVAILABLE` and not `EXIT.USAGE`: the command line was
   * correct, the machine simply cannot do this. That distinction is the whole
   * value of the ladder to a machine caller.
   */
  test("it exits BACKEND_UNAVAILABLE, names the backend, and writes no record", async () => {
    const runId = "2026-08-19T00-00-00Z-unit2";
    const run = runPaths(runId, root);
    await mkdir(run.workersDir, { recursive: true });
    await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }), "utf8");
    const wp = workerPaths(run, "eng-1");
    await mkdir(wp.dir, { recursive: true });
    await writeFile(
      wp.presentationJson,
      JSON.stringify({
        schema: "pifleet.presentation/v1",
        worker: "eng-1",
        backend: "headless",
        workspace_ref: null,
        surface_ref: null,
        window_ref: null,
      }),
      "utf8",
    );

    const err = await refusal(["--worker", "eng-1"]);
    expect(err.exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect(err.exitCode).not.toBe(EXIT.USAGE);
    expect(err.message).toMatch(/no pane to hand over/);
    // The backend is named, so the operator knows WHY rather than just that.
    expect(err.message).toContain("headless");

    expect(await Bun.file(wp.attendedJson).exists()).toBe(false);
  });

  /**
   * `--leave` takes the same refusal. The guard sits ABOVE the enter/leave
   * split on purpose: a `--leave` that fell through would call
   * `leaveTui` for a pane that never existed.
   */
  test("--leave on a headless worker is refused too", async () => {
    const runId = "2026-08-19T00-00-00Z-unit3";
    const run = runPaths(runId, root);
    await mkdir(run.workersDir, { recursive: true });
    await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }), "utf8");
    const wp = workerPaths(run, "eng-1");
    await mkdir(wp.dir, { recursive: true });
    await writeFile(
      wp.presentationJson,
      JSON.stringify({
        schema: "pifleet.presentation/v1",
        worker: "eng-1",
        backend: "headless",
        workspace_ref: null,
        surface_ref: null,
        window_ref: null,
      }),
      "utf8",
    );

    const err = await refusal(["--worker", "eng-1", "--leave"]);
    expect(err.exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect(err.message).toMatch(/no pane to hand over/);
    expect(await Bun.file(wp.attendedJson).exists()).toBe(false);
  });
});

/**
 * The registered surface, asserted because `tui` is reached ONLY through
 * commander: a command registered under the wrong name, or missing `--leave`,
 * is unreachable no matter how correct the action body is. `cli.test.ts`
 * cannot cover this — `tui` is deliberately absent from its SRD §10 list, and
 * that list is itself asserted to be exhaustive.
 */
describe("tui's registered surface", () => {
  test("registers as `tui` with the four options the command reads", () => {
    const program = new Command();
    register(program);
    const cmd = program.commands.find((c) => c.name() === "tui");
    expect(cmd, "tui did not register under the name `tui`").toBeDefined();
    const flags = cmd!.options.map((o) => o.long);
    expect(flags).toContain("--worker");
    expect(flags).toContain("--run");
    expect(flags).toContain("--leave");
    expect(flags).toContain("--json");
  });
});
