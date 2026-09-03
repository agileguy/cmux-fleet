/**
 * A `pane_mode: tui` supervisor records that its transcript is being written,
 * WITHOUT any dispatch.
 *
 * ## The defect this closes
 *
 * Operations console, 2026-09-01. The status pane read
 *
 *     tick-1: idle task=- supervisor=up
 *
 * beside a pane that was mid-turn — writing files, transcript 300 KB and
 * growing. Nothing was broken: `phase` and `task_id` describe an EPOCH, and
 * `dispatch` refuses the socket route for a `tui` worker, so a pane a person
 * types into never holds one. `idle` was true, and was going to stay true for
 * the whole life of the run, for the two panes the console exists to show.
 *
 * ## Why this is an integration test and not a unit one
 *
 * The unit suite grades the two halves separately — `status-transcript-activity.test.ts`
 * proves the renderer, `supervisor-tui.test.ts` proves the poll's SHAPE by
 * reading the source. Neither proves that a running supervisor ever writes the
 * field, and the defect was precisely that a value an operator reads was never
 * produced. So this one runs a real detached supervisor, against a real
 * transcript file that really grows, and reads the real `state.json`.
 *
 * ## The rig, and the one thing that is faked
 *
 * `docker` on PATH. The tui launch arm hands `detachedDockerArgv(launch.argv)`
 * to the launcher, which means the supervisor genuinely execs `docker run -d
 * …`; the stand-in prints a container id and exits 0, which is what a real
 * `docker run -d` does and is why the supervisor survives it (`tuiMode &&
 * code === 0` is not a dead worker). Everything else is production code: the
 * launch record is parsed by `WorkerLaunchSchema`, the poll is the shipped
 * `transcriptPoll`, the discovery is `discoverSessionPath`, and the state file
 * is written by `writeWorkerState`.
 *
 * The transcript is written by this test rather than by a fake Pi, because
 * what is under test is the supervisor's reading of a file that grows — not
 * anyone's ability to produce one.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { appendFile, chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { WorkerLaunchSchema, type WorkerState } from "../../src/contracts.ts";
import { runPaths, workerPaths, type WorkerPaths } from "../../src/run/paths.ts";
import { readWorkerState } from "../../src/run/state.ts";
import { processStartTime } from "../../src/run/registry.ts";
import { processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  if (process.env["PIFLEET_INT_KEEP"] === "1") return;
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

/** Unique per process: the control socket is derived from the run id, not the root. */
const RUN_ID = `int-tui-act-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const WORKER = "tick-1";

async function waitFor<T>(
  read: () => Promise<T | null>,
  ok: (v: T) => boolean,
  budgetMs: number,
): Promise<T | null> {
  const start = performance.now();
  for (;;) {
    const v = await read();
    if (v !== null && ok(v)) return v;
    if (performance.now() - start > budgetMs) return v;
    await new Promise((r) => setTimeout(r, 100));
  }
}

/**
 * One session-transcript line in the shape `isTreeEntry` accepts.
 *
 * `parentId` chained rather than always null so the file is a plausible
 * transcript; the reader keys on `id` and would happily take a forest, but a
 * fixture that could not be a real session is a fixture that stops being
 * evidence the moment the reader gets stricter.
 */
function entry(n: number): string {
  return `${JSON.stringify({
    type: "message",
    id: `e${n}`,
    parentId: n === 1 ? null : `e${n - 1}`,
    message: { role: n % 2 === 1 ? "user" : "assistant", content: `line ${n}` },
  })}\n`;
}

interface Rig {
  wp: WorkerPaths;
  sessionPath: string;
  pid: number;
  pgid: number;
}

async function bootTuiSupervisor(): Promise<Rig> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-tui-act-"));
  cleanups.push(() => rm(base, { recursive: true, force: true }));
  const root = join(base, "runs");
  const run = runPaths(RUN_ID, root);
  await mkdir(run.workersDir, { recursive: true });
  await mkdir(run.sessionsDir, { recursive: true });
  await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: RUN_ID }));

  const wp = workerPaths(run, WORKER);
  await mkdir(wp.dir, { recursive: true });
  await writeFile(
    wp.launchJson,
    JSON.stringify(
      WorkerLaunchSchema.parse({
        kind: "container",
        // A real `docker run …` argv: `detachedDockerArgv` refuses anything
        // else, and refusing is the production behaviour, not a test detail.
        argv: ["docker", "run", "-i", "-t", "--rm", "img", "pi"],
        container: `pifleet-${RUN_ID}-${WORKER}`,
        image: "img",
        pane_mode: "tui",
      }),
    ),
  );

  // The stand-in `docker`, behaving as `docker run -d` does: print an id, exit.
  const bin = join(base, "bin");
  await mkdir(bin, { recursive: true });
  const fake = join(bin, "docker");
  await writeFile(fake, "#!/bin/sh\necho 0123456789ab\nexit 0\n");
  await chmod(fake, 0o755);

  const { pid, pgid } = await processLauncher.launchDetached({
    runId: RUN_ID,
    runDir: join(root, RUN_ID),
    workerId: WORKER,
    argv: supervisorArgv({ runsRoot: root, runId: RUN_ID, workerId: WORKER }),
    env: { PATH: `${bin}:${process.env["PATH"] ?? ""}` },
    logPath: join(wp.dir, "supervisor.log"),
  });
  cleanups.push(async () => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        /* already gone */
      }
    }
  });

  return {
    wp,
    // The name `discoverSessionPath` matches on: `<ISO>_<worker>.jsonl`, flat.
    sessionPath: join(run.sessionsDir, `2026-09-01T06-00-09-284Z_${WORKER}.jsonl`),
    pid,
    pgid,
  };
}

describe("a tui supervisor reports transcript activity with no epoch (SRD §7.6)", () => {
  test(
    "a growing transcript becomes transcript_activity in state.json",
    async () => {
      const rig = await bootTuiSupervisor();

      // The supervisor is genuinely up before anything is asserted about what
      // it wrote — a state file outlives the process, so a field found on a
      // corpse would prove nothing about the poll.
      expect(await processStartTime(rig.pid)).not.toBeNull();

      // First growth. The file appears AFTER the supervisor started, which is
      // the real ordering: Pi creates it lazily on the first assistant message.
      await writeFile(rig.sessionPath, entry(1) + entry(2));

      const first = await waitFor<WorkerState>(
        () => readWorkerState(rig.wp),
        (s) => s.transcript_activity !== null && s.transcript_activity.entries >= 2,
        20_000,
      );
      expect(first, "no state.json at all").not.toBeNull();
      const act = first!.transcript_activity;
      expect(act, `transcript_activity was never written; state was ${JSON.stringify(first)}`).not.toBeNull();
      expect(act!.entries).toBe(2);
      expect(act!.last_growth_at).not.toBeNull();

      /**
       * THE ASSERTION THE DEFECT WAS. Everything the status pane printed is
       * still exactly what it printed on the console, and the new field is the
       * only thing that distinguishes this worker from one sitting at a prompt.
       *
       * Asserted rather than assumed, because a fix that made `phase` read
       * `busy` here would satisfy every other line in this file and would
       * break `wait`, `report` and the ledger, all of which route on `phase`.
       */
      expect(first!.phase).toBe("idle");
      expect(first!.task_id).toBeNull();
      expect(first!.epoch).toBe(0);

      // Second growth. One reading proves the field exists; two prove it
      // TRACKS — a value written once at discovery and never updated would
      // pass everything above and would be the same defect one field along.
      const before = act!.last_growth_at!;
      await new Promise((r) => setTimeout(r, 1_100));
      await appendFile(rig.sessionPath, entry(3));

      const second = await waitFor<WorkerState>(
        () => readWorkerState(rig.wp),
        (s) => (s.transcript_activity?.entries ?? 0) >= 3,
        20_000,
      );
      expect(second!.transcript_activity!.entries).toBe(3);
      expect(
        Date.parse(second!.transcript_activity!.last_growth_at!),
        "last_growth_at did not advance on the second write",
      ).toBeGreaterThan(Date.parse(before));
    },
    /**
     * A hand-picked literal, under the standing ISC-274 exception, because
     * this test's cost is bounded by something OTHER than the processes it
     * starts.
     *
     * It spawns twice — the supervisor, and the `ps` behind `processStartTime`
     * — so `cliBudget(2)` would apply. That value does not govern: nearly all
     * of the duration is the two 20_000 ms `waitFor` windows, which exist
     * because the supervisor polls on a 500 ms interval and a loaded machine
     * may take many polls to get there. A ceiling derived from spawn count
     * could land BELOW those windows, in which case bun kills the test while
     * it is still legitimately waiting and the failure names the timeout
     * rather than the missing field. 60_000 is the two windows plus room for
     * a cold supervisor start and the deliberate 1_100 ms pause between the
     * two writes.
     */
    60_000,
  );
});

/**
 * ISC-492 — the behavioural half, and the reason this file gained a second
 * `describe` rather than the unit suite gaining another string assertion.
 *
 * `test/unit/transcript-activity-gap.test.ts` pins the REPAIR by reading
 * `supervisor/index.ts` as text. That is worth having and it is not evidence
 * that a supervisor behaves differently — a source-text assertion passes
 * against code that never runs. This boots a real `tui` supervisor with no
 * session file at all and reads what it actually wrote.
 *
 * **The gap this closes was measured, not imagined.** On 2026-09-02 four of
 * six live attended workers had carried `transcript_activity: null` for nine
 * hours, because a `tui` worker's session file is created lazily on its first
 * assistant message and nobody had typed at them. `null` is what an `rpc`
 * worker carries too, so `pifleet status` rendered the two identically and an
 * operator could not tell a worker that had never spoken from one whose turns
 * do not run here.
 *
 * This test needs no Docker: the rig's `docker` is a shell stub, so it runs in
 * CI's ordinary `bun test test/integration` step rather than behind the
 * container gate. That is deliberate — a criterion whose only probe sits
 * behind a gate is the shape that gets graded `[~]` forever.
 */
describe("a tui supervisor with no session file says so rather than staying silent (ISC-492)", () => {
  test(
    "transcript_activity becomes entries:0 / last_growth_at:null, never left null",
    async () => {
      const rig = await bootTuiSupervisor();

      // Up first: a field found on a corpse would prove nothing about the poll.
      expect(await processStartTime(rig.pid)).not.toBeNull();

      // NOTHING is written to rig.sessionPath. That absence is the whole
      // fixture — this is the state every attended worker is in before the
      // first thing anyone says to it.
      const state = await waitFor<WorkerState>(
        () => readWorkerState(rig.wp),
        (s) => s.transcript_activity !== null,
        20_000,
      );

      expect(state, "the poll never wrote the field at all — ISC-492 has regressed").not.toBeNull();
      // THE CRITERION: measured-and-never-grew, which is a different fact from
      // the `null` an rpc worker carries and from any positive entry count.
      expect(state!.transcript_activity).toEqual({ entries: 0, last_growth_at: null });

      // The discriminator the monitor's activity ladder depends on: this worker
      // is attended and silent, and `session_present` stays false because no
      // file exists to latch on.
      expect(state!.session_present).toBe(false);
      expect(state!.session_path).toBeNull();
    },
    /**
     * A hand-picked literal under the standing ISC-274 exception, with the
     * derivation written out because the guard requires it rather than as a
     * courtesy.
     *
     * This test has 2 reachable spawn sites — the supervisor itself, and the
     * `ps` behind `processStartTime` — so the derived ceiling would be
     * `cliBudget(2)`. **That value does not govern.** Almost all of the
     * duration here is the single 20_000 ms `waitFor` window, which exists
     * because the supervisor polls on a 500 ms interval and a loaded machine
     * may need many polls to get there. A ceiling derived from spawn count can
     * land BELOW that window, and when it does bun kills the test while it is
     * still legitimately waiting — so the failure names a timeout instead of
     * the missing field, which is the diagnosis pointing at the wrong thing.
     *
     * 40_000 is the one window plus room for a cold supervisor start. Half of
     * the sibling test's 60_000 above, because this one waits once where that
     * one waits twice and has no deliberate inter-write pause.
     */
    40_000,
  );
});
