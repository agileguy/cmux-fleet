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
import {
  runPaths,
  taskRecordPath,
  workerPaths,
  type RunPaths,
  type WorkerPaths,
} from "../../src/run/paths.ts";
import { readTaskRecord, readWorkerState } from "../../src/run/state.ts";
import { processStartTime } from "../../src/run/registry.ts";
import { controlCall, processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";
import { TaskEnvelopeSchema } from "../../src/contracts.ts";
import { cliBudget } from "../support/budget.ts";

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
  run: RunPaths;
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
    run,
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

/**
 * The `/new` rename, driven through a real supervisor — SRD-WORKER-DISPATCH
 * ISC-1112.
 *
 * `resetPaneSession` types `/new` at an idle `tui` pane so the next task starts
 * on an empty session. Pi obeys, and names the new session after its OWN
 * generated id — `--session-id` covers the first session only, and `/session`
 * reports rather than sets. So the seat's transcript MOVES, to a filename
 * `discoverSessionPath` was never going to match.
 *
 * **What that cost, measured on 2026-09-08/09 rather than reasoned about.**
 * `tri-1` completed sweep 5 in its worker-named session, was reset, and
 * completed sweep 6 in a UUID-named one. Every host surface went on reading the
 * first file: `status` reported the seat frozen at the reset instant, the
 * triage actor's join waited 780 s for a task record "under tri-1" and failed a
 * pass the seat had in fact delivered, and the envelope landed carrying
 * `"worker": "01a08415-…"`. Eight runs hold the same orphaned pair, one of them
 * having skipped 28 consecutive ticks across 7.7 hours. The work ran and
 * delivered through `submit_report` every time; only the attribution was lost.
 *
 * ## Why this is an integration test and not another unit assertion
 *
 * `supervisor-tui.test.ts` pins `discoverSessionPath` — that the search CAN
 * adopt, and the two conditions under which it refuses. That is the half a pure
 * function can answer. It cannot answer the half that actually bit: the
 * supervisor called the search **once**, while `session_path` was null, and
 * never looked again. A search that adopts perfectly, called once at start-up,
 * reproduces the entire defect with every unit test green — so the criterion
 * has to be "a running supervisor notices", and only a running supervisor can
 * be asked.
 *
 * Needs no Docker, for the reason the ISC-492 block above gives: the rig's
 * `docker` is a shell stub, so this runs in CI's ordinary integration step
 * rather than behind the container gate.
 */
describe("a tui supervisor follows its seat through a /new (ISC-1112)", () => {
  test(
    "a Pi-generated session replaces the worker-named one mid-run",
    async () => {
      const rig = await bootTuiSupervisor();
      expect(await processStartTime(rig.pid)).not.toBeNull();

      // Phase 1: the ordinary life of a tui seat. The worker-named session
      // appears and is found by NAME, which is the pre-existing behaviour and
      // the baseline everything below is a change from.
      await writeFile(rig.sessionPath, entry(1) + entry(2));
      const before = await waitFor<WorkerState>(
        () => readWorkerState(rig.wp),
        (s) => (s.transcript_activity?.entries ?? 0) >= 2,
        20_000,
      );
      expect(before, "the supervisor never found the worker-named session").not.toBeNull();
      expect(before!.session_path).toBe(rig.sessionPath);
      expect(before!.transcript_activity!.entries).toBe(2);

      /*
       * Phase 2: the reset. Pi's new session is a SEPARATE file with a
       * generated id, and the old one simply stops growing — it is not deleted,
       * which is exactly why the stale path went unnoticed for hours. The
       * fixture reproduces that: the first file is left in place, intact.
       *
       * Three entries rather than a continuation of the first file's two,
       * because the count is what proves WHICH file is being read. A supervisor
       * still on the old path reports 2 for ever; one that followed reports 3,
       * and no arithmetic on the old file produces 3.
       */
      const renamed = join(
        rig.wp.dir,
        "..",
        "..",
        "sessions",
        "2026-09-01T06-05-00-000Z_01a08415-44aa-7645-b3d1-e1ab590e5126.jsonl",
      );
      await writeFile(renamed, entry(1) + entry(2) + entry(3));

      const after = await waitFor<WorkerState>(
        () => readWorkerState(rig.wp),
        (s) => s.session_path !== null && s.session_path.includes("01a08415"),
        30_000,
      );
      expect(
        after,
        "the supervisor never adopted the renamed session — it is still reading the file " +
          "the seat stopped writing to, which is the defect this closes",
      ).not.toBeNull();

      // The path moved…
      expect(after!.session_path).toBe(renamed);
      expect(after!.session_path).not.toBe(rig.sessionPath);

      // …and the READING moved with it, which is the half that matters. A
      // recorded path nothing polls is a cosmetic fix.
      const read = await waitFor<WorkerState>(
        () => readWorkerState(rig.wp),
        (s) => (s.transcript_activity?.entries ?? 0) >= 3,
        20_000,
      );
      expect(read, "the path was adopted but its entries were never counted").not.toBeNull();
      expect(read!.transcript_activity!.entries).toBe(3);

      // Still an attended seat with no epoch. Asserted because a fix that made
      // this worker look busy would satisfy everything above and break `wait`,
      // `report` and the ledger, all of which route on `phase`.
      expect(read!.phase).toBe("idle");
      expect(read!.epoch).toBe(0);
    },
    /**
     * A hand-picked literal under the same standing ISC-274 exception the block
     * above takes, and for the same reason.
     *
     * This test spawns twice — the supervisor, and the `ps` behind
     * `processStartTime` — so `cliBudget(2)` would apply. **That value does not
     * govern here.** Nearly all of the duration is three `waitFor` windows
     * totalling 70_000 ms, and they are that wide because the supervisor polls
     * at `TUI_POLL_MS` while only re-running the session search every
     * `SESSION_REDISCOVER_MS` — so the adoption is up to five seconds behind
     * the write on an idle machine and further behind on a loaded one. A
     * ceiling derived from spawn count could land BELOW those windows, and bun
     * would then kill the test while it is still legitimately waiting, naming
     * the timeout instead of the session path that never moved. 90_000 is the
     * three windows plus room for a cold supervisor start.
     */
    90_000,
  );
});

/**
 * ISC-1117 — the baseline is an INDEX, and adoption moves the file under it.
 *
 * ISC-1112 taught the supervisor to follow a seat through the `/new` its own
 * settle types. It did not teach `tuiBaselineCount` to follow, and that count is
 * an offset into whichever transcript was current when the epoch went live. Move
 * the file and the offset addresses the wrong place; make the new file shorter
 * than the offset and it addresses nothing at all — `classifyTuiTurn` reads an
 * empty window, answers `awaiting_start` for ever, and the epoch runs to its
 * deadline while the finished turn sits on disk.
 *
 * Measured on run `2026-09-09T05-21-27Z-6767`, both directions in one file:
 * sweep 11 took `entries_before: 10` against an eleven-entry transcript, was
 * pointed at a four-entry one seven seconds later, and burned 25 minutes to
 * `deadline_exceeded`; sweep 12 took its baseline against the file it then read
 * and settled in 22 seconds. The turns were indistinguishable.
 *
 * **The deadline is the thing NOT being waited for here.** A test that waited
 * out a real `deadline_exceeded` would take longer than the suite allows and
 * would prove the timeout works rather than that the re-base does. What is
 * asserted instead is the positive: the epoch reaches a terminal verdict from a
 * turn written entirely into the SECOND transcript. Under the defect no record
 * appears at all within the budget, which is the failure this reddens on.
 */
describe("a baseline re-bases when the transcript moves under it (ISC-1117)", () => {
  /** A terminating assistant entry — `stopReason: "stop"` ends the turn. */
  function endsTurn(n: number): string {
    return `${JSON.stringify({
      type: "message",
      id: `x${n}`,
      parentId: `x${n - 1}`,
      message: { role: "assistant", content: "done", stopReason: "stop" },
    })}\n`;
  }
  function turnEntry(n: number, role: string): string {
    return `${JSON.stringify({
      type: "message",
      id: `x${n}`,
      parentId: n === 1 ? null : `x${n - 1}`,
      message: { role, content: `t${n}` },
    })}\n`;
  }

  test(
    "a turn written wholly into the adopted session still settles",
    async () => {
      const rig = await bootTuiSupervisor();

      /*
       * A LONG first transcript, and the length is the point: it is what makes
       * the stale index out-of-range on the short file that replaces it, which
       * is the shape that reads NOTHING rather than merely reading the wrong
       * offset. Eight entries against the three the second file opens with.
       */
      let first = "";
      for (let n = 1; n <= 8; n++) first += entry(n);
      await writeFile(rig.sessionPath, first);
      const found = await waitFor(
        () => readWorkerState(rig.wp),
        (s: WorkerState) => s.session_path === rig.sessionPath,
        30_000,
      );
      expect(found?.session_path, "the first session was never discovered").toBe(rig.sessionPath);

      // Stage an epoch. The baseline is taken on the poll after this, against
      // the EIGHT-entry file above — exactly as sweep 11's was.
      const reply = await controlCall(rig.run, WORKER, {
        cmd: "stage",
        envelope: TaskEnvelopeSchema.parse({
          schema: "pifleet.task/v1",
          task_id: "T-REBASE",
          run_id: RUN_ID,
          epoch: 0,
          attempt: 1,
          worker: WORKER,
          dispatched_at: new Date().toISOString(),
          title: "rebase",
          brief: "do the thing",
          repo: "unset",
          host_workdir: "unset",
          container_workdir: "/workspace",
          branch: `fleet/${RUN_ID}/${WORKER}`,
          base_ref: "0".repeat(40),
          outbox: "/outbox/T-REBASE",
          // Long enough that a `timed_out` cannot be what makes this pass: the
          // record this test waits for has to come from the turn being READ.
          deadline_s: 900,
        }),
        attempt_id: "att-rebase",
        requested_epoch: null,
      });
      expect(reply["accepted"], "the stage was refused").toBe(true);

      // Let the baseline land on the first file before the switch, so this
      // reproduces the ordering rather than dodging it.
      await new Promise((r) => setTimeout(r, 1_500));

      /*
       * The `/new`: a Pi-generated session id, which is the only shape
       * `discoverSessionPath` will adopt (ISC-1112), carrying the WHOLE turn.
       */
      const adopted = join(
        rig.run.sessionsDir,
        "2026-09-01T06-30-00-000Z_01a08467-0ebe-711a-9a53-e1ab590e5126.jsonl",
      );
      await writeFile(adopted, turnEntry(1, "user") + turnEntry(2, "assistant") + endsTurn(3));

      const record = await waitFor(
        () => readTaskRecord(taskRecordPath(rig.wp, "T-REBASE")),
        () => true,
        60_000,
      );
      expect(
        record,
        "no task record — the epoch never read the turn in the session it had moved to",
      ).not.toBeNull();
      // The verdict comes from `stopReason: "stop"`, so it is evidence the
      // classifier ran over the NEW file's entries and not merely that some
      // terminal state was reached.
      expect(record?.reason).toBe("transcript_quiesced");
      expect(record?.verdict).toBe("success");
    },
    // One gate at 30 s, a 1.5 s settle for the baseline, one at 60 s, plus the
    // supervisor launch. No CLI subprocess and no container: compared against
    // cliBudget(2) and taken as the larger of the two.
    Math.max(cliBudget(2), 120_000),
  );
});
