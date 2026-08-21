/**
 * `down` against a `ps` it cannot read (ISC-192, identity channel).
 *
 * ## Why this file exists
 *
 * `processStartTime` stopped reporting a failed `ps` as an absent process, and
 * `down` grew a matching per-worker verdict — `identity_read_failed` — so one
 * broken reading refuses ONE worker instead of declaring it gone. Six guards
 * were added across `down.ts` to carry that: the `anchorIdentity` wrapper, the
 * `waitGone` leniency, the worker rung's `how` and `stopped`, the daemon
 * rung's outcome capture, and the split remedy text.
 *
 * An adversarial pass reverted all six IN TURN and the suite stayed green
 * every time. Only the classification assertion in `down-prune.test.ts` bit.
 * The guards were correct and nothing held them there, which is the shape this
 * project keeps re-learning: a branch, its error type and its operator wording
 * added together, with no fixture naming any of them, so deleting the whole
 * thing leaves a green suite.
 *
 * ## How a broken `ps` is produced
 *
 * `processStartTime` hard-codes its argv but resolves `ps` through PATH, and
 * `down` runs as a real subprocess here — so the run gets a PATH whose only
 * entry holds a `ps` that exits non-zero with a diagnostic on stderr. Nothing
 * about the pid matters, which is the point: the refusal is a property of the
 * reading. The planted pids are LIVE (this test process) so that a
 * fall-through past the shim would be answered normally and every assertion
 * below would fail loudly rather than pass for the wrong reason.
 *
 * ## Budget
 *
 * Each test spawns the CLI once. `cliBudget(1)` is the derived ceiling.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile, chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import { EXIT } from "../../src/contracts.ts";
import { cliBudget } from "../support/budget.ts";

const CLI = join(import.meta.dir, "..", "..", "src", "cli", "index.ts");
const bases: string[] = [];

afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true });
});

/** A PATH holding one `ps`, and that `ps` refuses to read anything. */
async function brokenPsDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-down-brokenps-"));
  bases.push(dir);
  const stub = join(dir, "ps");
  await writeFile(stub, '#!/bin/sh\necho "ps: cannot read process table" 1>&2\nexit 1\n', "utf8");
  await chmod(stub, 0o755);
  return dir;
}

async function plantRun(workerIds: string[]): Promise<{ root: string; runId: string }> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-down-ups-"));
  bases.push(base);
  const root = join(base, "runs");
  const runId = "2026-08-21T00-00-00Z-ups1";
  const run = runPaths(runId, root);
  await mkdir(run.workersDir, { recursive: true });
  await writeFile(
    run.runJson,
    JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }),
    "utf8",
  );
  for (const id of workerIds) {
    const wp = workerPaths(run, id);
    await mkdir(wp.dir, { recursive: true });
    await writeWorkerState(
      wp,
      initialWorkerState({
        worker: id,
        runId,
        // LIVE pid: a real `ps` answers it, so a shim that failed to take
        // effect makes these tests fail rather than quietly pass.
        pid: process.pid,
        pgid: process.pid,
        startedAt: new Date().toISOString(),
        procStarted: "utc1 Thu Jan  1 00:00:00 1970",
      }),
    );
  }
  return { root, runId };
}

async function downWithBrokenPs(
  root: string,
  runId: string,
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, "down", "--run", runId, "--json", ...args], {
    // PATH REPLACED, not prepended: a fall-through to the real `ps` would make
    // a failing assertion look like a passing one.
    env: { PATH: await brokenPsDir(), PIFLEET_RUNS_DIR: root },
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

describe("down refuses a worker whose identity cannot be read (ISC-192)", () => {
  test(
    "an unreadable ps refuses EVERY worker rather than aborting the command",
    async () => {
      const { root, runId } = await plantRun(["eng-1", "eng-2"]);
      const r = await downWithBrokenPs(root, runId);

      // THE LOAD-BEARING ASSERTION. Before the `anchorIdentity` wrapper, the
      // first unreadable pid threw out of a worker loop that is not inside a
      // try — so the command died with no report at all, and `--json` was
      // never written. Two rows here means the loop survived the first
      // failure and kept going.
      const env = parse(r.stdout);
      const workers = env["workers"] as Array<Record<string, unknown>>;
      expect(workers).toHaveLength(2);
      for (const w of workers) {
        // NOT `already_gone`, and NOT `stopped: true` — an unreadable `ps`
        // establishes nothing, least of all that the supervisor is dead.
        expect(w["stopped"]).toBe(false);
        expect(w["how"]).toBe("identity_read_failed");
      }
      expect(env["clean"]).toBe(false);
      expect(r.code).not.toBe(EXIT.SUCCESS);
    },
    cliBudget(1),
  );

  test(
    "--prune keeps every checkout, and the remedy offered is not --force-identity",
    async () => {
      const { root, runId } = await plantRun(["eng-1"]);
      const r = await downWithBrokenPs(root, runId, ["--prune"]);

      // `stopped: false` is what blocks the prune gate; this asserts the
      // consequence rather than the flag.
      const pruned = parse(r.stdout)["pruned"] as Array<Record<string, unknown>> | undefined;
      for (const p of pruned ?? []) expect(p["pruned"]).toBe(false);

      // The remedy must fit the refusal. `--force-identity` re-anchors on
      // whatever holds the pid using the very reading that just failed, so
      // offering it here sends an operator to disable the identity check in
      // order to work around a broken machine.
      expect(r.stderr).not.toContain("--force-identity signals the supervisor alone");
      expect(r.stderr).toMatch(/could not be read|cannot help/);
    },
    cliBudget(1),
  );
});

/**
 * A `ps` that WORKS at anchor time and fails afterwards — the transient case.
 *
 * The two tests above are answered entirely by `anchorIdentity`'s wrapper: the
 * very first read fails, so the anchor refuses and the ladder never runs. That
 * leaves the worker rung's own two guards — `how` and `stopped` — untested,
 * and `stopped` is the one that matters: with `!held` instead of
 * `held === false`, an unreadable identity reports `stopped: TRUE`, which is a
 * completed stop, which reaches the prune gate as prunable.
 *
 * So this shim answers the first N reads and then breaks. The identity it
 * prints is fixed and the fixture records the matching `proc_started`, so the
 * anchor confirms and the ladder is entered for real.
 *
 * WHAT THIS TEST DOES NOT REACH, measured rather than assumed. The intent was
 * to land the failure on the worker rung's own two guards (`how` and
 * `stopped`). It does not, at any threshold from 1 to 6 — the verdict is
 * `identity_read_failed` every time, produced EARLIER, by the anchor wrapper
 * or by the SIGTERM rung's outcome branch. `waitGone` polls until its budget
 * expires when the read returns `null`, so by the time control reaches the
 * rung the failure has already been converted into the same verdict.
 *
 * That makes `if (held === null) how = ...` and `stopped = held === false`
 * DEFENSIVE rather than reachable: the only window they cover is a read that
 * succeeds at the rung and fails microseconds later, at the final check. They
 * are kept — the alternative, `!held`, reports `stopped: true` for an
 * unreadable identity, which is a completed stop and reaches the prune gate —
 * but they are honestly untested, and the ISA records them as such rather than
 * this file implying otherwise.
 */
async function flakyPsDir(okReads: number, pgid: number): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-down-flakyps-"));
  bases.push(dir);
  const counter = join(dir, "calls");
  const stub = join(dir, "ps");
  await writeFile(
    stub,
    `#!/bin/sh\n` +
      // The GROUP read always succeeds and always agrees. The worker path
      // confirms the group before every signal (`state.pgid` is never null,
      // so `confirmGroup` always runs), and a group refusal would end the run
      // before the identity guards under test are ever reached.
      `case "$*" in *pgid*) echo "${String(pgid)}"; exit 0 ;; esac\n` +
      // Only the IDENTITY reads are counted, so the threshold means what it
      // says regardless of how many group reads happen alongside them. One
      // FILE per invocation rather than a read-modify-write counter: `ps` is
      // spawned repeatedly and a shell that reads-then-writes can lose an
      // increment, which silently turns "fails after N" into "never fails".
      `mkdir -p ${counter}\n` +
      `: > ${counter}/$$-$(date +%s%N 2>/dev/null || echo $RANDOM)\n` +
      `n=$(ls ${counter} | wc -l)\n` +
      `if [ "$n" -le ${String(okReads)} ]; then echo "Thu Jan  1 00:00:00 1970"; exit 0; fi\n` +
      `echo "ps: cannot read process table" 1>&2\nexit 1\n`,
    "utf8",
  );
  await chmod(stub, 0o755);
  return dir;
}

describe("a ps that fails MID-LADDER still refuses rather than reporting a stop", () => {
  test(
    "an identity read failing after the anchor is stopped:false, never a completed stop",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "pifleet-down-flaky-"));
      bases.push(base);
      const root = join(base, "runs");
      const runId = "2026-08-21T00-00-00Z-flk1";
      const run = runPaths(runId, root);
      await mkdir(run.workersDir, { recursive: true });
      await writeFile(
        run.runJson,
        JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }),
        "utf8",
      );
      const wp = workerPaths(run, "eng-1");
      await mkdir(wp.dir, { recursive: true });
      await writeWorkerState(
        wp,
        initialWorkerState({
          worker: "eng-1",
          runId,
          pid: process.pid,
          // A group the shim confirms: `state.pgid` is never null on the
          // worker path, so `confirmGroup` runs and must SUCCEED, or the run
          // ends on a group refusal before the identity guards are reached.
          pgid: process.pid,
          startedAt: new Date().toISOString(),
          procStarted: "utc1 Thu Jan  1 00:00:00 1970",
        }),
      );

      const p = Bun.spawn([process.execPath, CLI, "down", "--run", runId, "--json"], {
        env: { PATH: await flakyPsDir(1, process.pid), PIFLEET_RUNS_DIR: root },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, , code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);

      const worker = (parse(stdout)["workers"] as Array<Record<string, unknown>>)[0]!;
      // The data-loss assertion. `!held` would make this `true`.
      expect(worker["stopped"]).toBe(false);
      // And the guard that names it, so a drift in the read count is visible.
      expect(worker["how"]).toBe("identity_read_failed");
      expect(code).not.toBe(EXIT.SUCCESS);
    },
    cliBudget(1),
  );
});
