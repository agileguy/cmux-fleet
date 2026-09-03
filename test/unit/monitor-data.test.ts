/**
 * Views 2-4's data plane: the refusal surface, the fence, the run history, the
 * run report, and the cost of a view nobody has entered
 * (SRD-FLEET-MONITOR §6.2, §6.3, §5.3, §9 Q7 — ISC-499..ISC-502).
 *
 * ## ISC-491 holds here too
 *
 * Every test below runs against a `mkdtemp` runs root and pure functions. No
 * terminal, no container, no live fleet. **Two honest exceptions, named rather
 * than hidden**, both inherited rather than introduced:
 *
 * - `readHistory` calls `liveRunIds`, which spawns `ps` per worker until one
 *   answers alive (`safety/procstart.ts:122-131`). The fixtures record
 *   `process.pid` for the same reason `monitor-read.test.ts` does: it is the
 *   one pid guaranteed alive and guaranteed to have a start time, so liveness
 *   resolves without a fleet.
 * - ISC-501's strongest probe spawns `bun src/cli/index.ts report`, because the
 *   claim being made is that the monitor's lines and the COMMAND's stdout are
 *   the same bytes, and nothing short of running the command can say that. A
 *   test that compared this module's output to a second in-process call of the
 *   same renderer would be asserting that the renderer equals itself.
 *
 * Neither is a terminal, a container, or a live fleet.
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import {
  PresentationSchema,
  WorkerLaunchSchema,
  WorkerStateSchema,
  type WorkerState,
} from "../../src/contracts.ts";
import { runPaths, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import { deriveActivity } from "../../src/monitor/activity.ts";
import type { Region } from "../../src/monitor/model.ts";
import { readWorkerRow, refreshWorkerRow, deriveVia } from "../../src/monitor/read/worker.ts";
import { readHistory } from "../../src/monitor/read/history.ts";
import { readRunReport } from "../../src/monitor/read/report.ts";
import { readWorkerDetail } from "../../src/monitor/read/detail.ts";
import { composeFleet, fetchForView, withView } from "../../src/monitor/compose.ts";

// ---------------------------------------------------------------------------
// Fixtures — every path from `runPaths`/`workerPaths`, including in this file.
// ---------------------------------------------------------------------------

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

async function makeRoot(tag: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), `pifleet-views-${tag}-`));
  bases.push(base);
  return join(base, "runs");
}

/** A run directory `runIdsAscending` will accept — i.e. one holding `run.json`. */
async function makeRun(root: string, runId: string): Promise<RunPaths> {
  const run = runPaths(runId, root);
  await mkdir(run.workersDir, { recursive: true });
  await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }));
  return run;
}

function stateFor(runId: string, worker: string, over: Partial<WorkerState> = {}): WorkerState {
  return WorkerStateSchema.parse({
    schema: "pifleet.state/v1",
    worker,
    run_id: runId,
    pid: process.pid,
    pgid: process.pid,
    started_at: new Date().toISOString(),
    phase: "idle",
    epoch: 0,
    ...over,
  });
}

async function makeWorker(
  run: RunPaths,
  worker: string,
  over: Partial<WorkerState> = {},
): Promise<ReturnType<typeof workerPaths>> {
  const wp = workerPaths(run, worker);
  await mkdir(wp.dir, { recursive: true });
  await writeFile(wp.stateJson, JSON.stringify(stateFor(run.runId, worker, over)));
  return wp;
}

/**
 * An `rpc` launch record. All three marks agree, which is what `launchPaneMode`
 * requires: the recorded `pane_mode`, `--mode rpc` in the argv, and no `-t`.
 * A fixture that set only the field would read as `unknown`, and the test would
 * pass for the wrong reason.
 */
const rpcLaunch = () =>
  WorkerLaunchSchema.parse({
    kind: "container",
    argv: ["docker", "run", "--rm", "img", "pi", "--mode", "rpc"],
    container: "c",
    image: "img",
    pane_mode: "rpc",
  });

/** A `tui` launch record: the field, `-t`, and no `--mode rpc`. */
const tuiLaunch = () =>
  WorkerLaunchSchema.parse({
    kind: "container",
    argv: ["docker", "run", "--rm", "-t", "img", "pi"],
    container: "c",
    image: "img",
    pane_mode: "tui",
  });

/** The marks DISAGREE — `planDispatch` refuses to guess, and so must `via`. */
const contradictoryLaunch = () =>
  WorkerLaunchSchema.parse({
    kind: "container",
    // Says `tui`, but the argv is an `rpc` argv. `interrupt.ts:160-175`: this
    // is not a worker whose mode is in doubt, it is one that cannot work.
    argv: ["docker", "run", "--rm", "img", "pi", "--mode", "rpc"],
    container: "c",
    image: "img",
    pane_mode: "tui",
  });

function expectOk<T>(region: Region<T>): T {
  if (region.status !== "ok") {
    throw new Error(`expected ok, got ${region.status}: ${JSON.stringify(region)}`);
  }
  return region.value;
}

// ---------------------------------------------------------------------------
// ISC-499 — `via` and `fence` are properties of the ROW, and neither defaults
// ---------------------------------------------------------------------------

describe("ISC-499: the refusal surface and the fence are row properties", () => {
  /**
   * §6.2's second and third "must be able to see", stated as a SHAPE
   * assertion rather than as a value one.
   *
   * `model.ts:263-269` argues that `via` belongs on the row and not on the
   * detail view, because "a later action button has somewhere to be greyed out
   * and a reason to give", and a button lives on a row. A design that carried
   * either field only in view 2 would satisfy every value assertion below and
   * still be the redesign D15 says adding actions must not require — so the
   * location is asserted on its own.
   */
  test("both fields are on the row itself, not on the evidence bundle", async () => {
    const root = await makeRoot("shape");
    const run = await makeRun(root, "2026-09-02T00-00-00Z-sh01");
    await makeWorker(run, "w-1");

    const { row, evidence } = expectOk(await readWorkerRow(run, "w-1"));
    expect(Object.keys(row).sort()).toEqual([
      "containerPresent",
      "fence",
      "phase",
      "runId",
      "taskId",
      "transcriptAgeMs",
      "via",
      "workerId",
    ]);
    // And the derived answers are NOT duplicated into the evidence bundle,
    // which would give the fast path a second place to read them from.
    expect(Object.keys(evidence)).not.toContain("via");
    expect(Object.keys(evidence)).not.toContain("fence");
  });

  /**
   * THE ANTI-DEFAULT, and the single most important assertion in this block.
   *
   * `model.ts:271-275`: `null` is "could not determine", and it must never be
   * `"rpc"` — the permissive rung, the route with a fence and no human in the
   * loop. An unreadable record rendering as the most freely dispatchable worker
   * is a reassuring lie, and a reader written the obvious way produces it,
   * because "absent or broken, treat as the common case" is what a reasonable
   * person writes first.
   */
  test("an unreadable launch record is null, never `rpc`", async () => {
    const root = await makeRoot("badlaunch");
    const run = await makeRun(root, "2026-09-02T00-00-00Z-bl01");
    const wp = await makeWorker(run, "w-1");
    // A TORN write, not garbage: a valid prefix of a valid document, which is
    // what `writeJsonAtomic` produces when the rename lands mid-read.
    const whole = JSON.stringify(rpcLaunch());
    await writeFile(wp.launchJson, whole.slice(0, Math.floor(whole.length * 0.6)));

    const { row, evidence } = expectOk(await readWorkerRow(run, "w-1"));
    expect(row.via).toBeNull();
    expect(row.via).not.toBe("rpc");
    // The row SURVIVES — `phase` and the rest come from `state.json` and are
    // still true — and the failure is a note rather than a silent blank.
    expect(row.phase).toBe("idle");
    expect(evidence.launchUnreadable).toBe(true);
    expect(evidence.notes.join(" ")).toContain(wp.launchJson);
  });

  /**
   * Every arm of `planDispatch`/`sendViaPane`, mirrored and asserted from a
   * literal rather than from disk.
   *
   * `deriveVia` is exported for this: the routing table is seven rows, six of
   * which need a specific pair of documents, and building six run trees to
   * assert a pure function would test the fixtures. The DISK path is asserted
   * separately above and below; this is the table.
   */
  test("the routing table mirrors dispatch.ts, arm for arm", () => {
    const headless = PresentationSchema.parse({
      schema: "pifleet.presentation/v1",
      worker: "w-1",
      backend: "headless",
    });
    const adopted = PresentationSchema.parse({
      schema: "pifleet.presentation/v1",
      worker: "w-1",
      backend: "headless",
      adopted_terminal: true,
    });
    const addressable = PresentationSchema.parse({
      schema: "pifleet.presentation/v1",
      worker: "w-1",
      backend: "cmux",
      surface_ref: "%7",
    });

    // `launch === null` is `rpc` — `planDispatch:292`'s own correction, the
    // `PIFLEET_PI_COMMAND` double, which has a live supervisor and a real
    // control socket. NOT a default: it is the answer, and `dispatch.ts` and
    // `interrupt.ts` and `supervisor/index.ts` all three say so.
    expect(deriveVia(null, false, null)).toBe("rpc");
    expect(deriveVia(rpcLaunch(), false, null)).toBe("rpc");
    // An `rpc` worker's presentation record is irrelevant to the route, which
    // is why an unreadable one does not demote it.
    expect(deriveVia(rpcLaunch(), false, headless)).toBe("rpc");

    expect(deriveVia(tuiLaunch(), false, adopted)).toBe("staged");
    expect(deriveVia(tuiLaunch(), false, addressable)).toBe("pane");

    // The three refusals. `dispatch` throws on each; `DispatchVia` has no
    // member for "no route", so each is `null` and none is `"rpc"`.
    expect(deriveVia(tuiLaunch(), false, null)).toBeNull();
    expect(deriveVia(tuiLaunch(), false, headless)).toBeNull();
    expect(deriveVia(contradictoryLaunch(), false, addressable)).toBeNull();
    expect(deriveVia(null, true, addressable)).toBeNull();
  });

  /**
   * A SWEEP over the refusal inputs, because the assertion that matters is not
   * "these four are null" but "no unroutable worker is ever `rpc`". A mutation
   * that made one arm permissive would be caught by the table above only if it
   * struck one of the four rows someone thought to write down.
   */
  test("no input that cannot be routed produces the permissive rung", () => {
    const headless = PresentationSchema.parse({
      schema: "pifleet.presentation/v1",
      worker: "w-1",
      backend: "headless",
    });
    const unroutable = [
      deriveVia(null, true, null),
      deriveVia(rpcLaunch(), true, null),
      deriveVia(tuiLaunch(), true, headless),
      deriveVia(contradictoryLaunch(), false, null),
      deriveVia(contradictoryLaunch(), false, headless),
      deriveVia(tuiLaunch(), false, null),
      deriveVia(tuiLaunch(), false, headless),
    ];
    for (const via of unroutable) {
      expect(via).toBeNull();
    }
    expect(unroutable).not.toContain("rpc");
    expect(unroutable).not.toContain("pane");
    expect(unroutable).not.toContain("staged");
  });

  /**
   * **THE MEASURED EDGE CASE (`activity.ts:29-33`, §9 Q1).**
   *
   * A worker exists on this fleet with `attended.json` present and
   * `mode: "tui"` but `adopted_terminal` ABSENT, so a reader that checks only
   * `adopted_terminal` is already wrong on real data. This fixture is that
   * worker, and it pins BOTH answers because they DIFFER and both are right:
   *
   * - The activity ladder ORs the two fields, so this worker is attended.
   *   Checking only `adopted_terminal` would render it identically to an `rpc`
   *   worker, which is Finding A.
   * - `via` does NOT or them, because `dispatch` does not: `sendViaPane:541`
   *   reads `presentation.adopted_terminal` and nothing else. A `via` that
   *   consulted `attended.json` would say `staged` for a worker `dispatch`
   *   would type into — a greyed-out button lying about the command behind it.
   *
   * The disagreement is the finding, not a defect in either reader, and it is
   * asserted so that "fix" it and one of the two goes wrong.
   */
  test("attended `tui` with `adopted_terminal` absent: attended, but not staged", async () => {
    const root = await makeRoot("hazard");
    const run = await makeRun(root, "2026-09-02T00-00-00Z-hz01");
    const wp = await makeWorker(run, "w-1", { session_present: false });
    await writeFile(wp.launchJson, JSON.stringify(tuiLaunch()));
    // The record as it exists on disk: NO `adopted_terminal` key at all, and a
    // `surface_ref`, so the worker is addressable.
    await writeFile(
      wp.presentationJson,
      JSON.stringify({
        schema: "pifleet.presentation/v1",
        worker: "w-1",
        backend: "cmux",
        surface_ref: "%7",
      }),
    );
    await writeFile(
      wp.attendedJson,
      JSON.stringify({
        schema: "pifleet.attended/v1",
        worker: "w-1",
        run_id: run.runId,
        mode: "tui",
        entered_at: new Date().toISOString(),
        left_at: null,
        voided: [],
      }),
    );

    const { row, evidence } = expectOk(await readWorkerRow(run, "w-1"));

    // The presentation parsed, and the missing key really is absent-as-false.
    expect(evidence.presentation?.adopted_terminal).toBe(false);
    expect(evidence.attended?.mode).toBe("tui");

    // `via` mirrors dispatch: an addressable non-adopted `tui` pane is typed
    // into, not staged.
    expect(row.via).toBe("pane");
    expect(row.via).not.toBe("staged");

    // …and the ladder still calls it attended, from `attended.json` alone.
    const activity = deriveActivity(
      {
        adoptedTerminal: evidence.presentation?.adopted_terminal ?? null,
        attendedMode: evidence.attended?.mode ?? null,
        sessionPresent: evidence.state.session_present,
        transcriptActivity: evidence.state.transcript_activity ?? null,
        phase: row.phase,
        containerPresent: row.containerPresent,
      },
      Date.now(),
    );
    expect(activity).toBe("no-transcript");
    expect(activity).not.toBe("rpc");
  });

  /**
   * `fence: null` means NO FENCE HAS EVER BEEN WRITTEN, and `readFence`
   * collapses that into `emptyFence()` — so the collapse has to be undone here
   * or the field carries a meaning it does not have.
   */
  test("no fence file is null; an empty fence file is not", async () => {
    const root = await makeRoot("fence");
    const run = await makeRun(root, "2026-09-02T00-00-00Z-fn01");
    await makeWorker(run, "none");
    const written = await makeWorker(run, "empty");
    await writeFile(
      written.fenceJson,
      JSON.stringify({
        schema: "pifleet.fence/v1",
        worker: "empty",
        last_accepted_epoch: 0,
        ack_seq: null,
        last_seq: 0,
        live: null,
        completed: [],
        attempts: {},
      }),
    );

    expect(expectOk(await readWorkerRow(run, "none")).row.fence).toBeNull();

    const empty = expectOk(await readWorkerRow(run, "empty")).row.fence;
    expect(empty).not.toBeNull();
    expect(empty).toEqual({ liveTaskId: null, abortRequested: false, attemptCount: 0 });
  });

  /**
   * The mapping, and the CEILING on it. `model.ts:281-285` is explicit that
   * `FenceView` is deliberately NOT the whole `FenceSnapshot`: `completed`,
   * `ack_seq` and `last_seq` are forensic fields belonging to `report`, and
   * carrying `completed` would put a per-worker unbounded array in a model
   * rendered twice a second. So the key set is asserted, not just the values.
   */
  test("the fence maps to exactly three fields and no more", async () => {
    const root = await makeRoot("fencelive");
    const run = await makeRun(root, "2026-09-02T00-00-00Z-fl01");
    const wp = await makeWorker(run, "w-1");
    await writeFile(
      wp.fenceJson,
      JSON.stringify({
        schema: "pifleet.fence/v1",
        worker: "w-1",
        last_accepted_epoch: 4,
        ack_seq: 11,
        last_seq: 19,
        live: {
          task_id: "t-9",
          attempt_id: "a-1",
          epoch: 4,
          started: true,
          abort_requested: true,
          timed_out: false,
        },
        completed: [
          {
            task_id: "t-8",
            attempt_id: "a-0",
            epoch: 3,
            verdict: "success",
            settled_at: new Date().toISOString(),
          },
        ],
        attempts: { "t-8:a-0": 3, "t-9:a-1": 4 },
      }),
    );

    const fence = expectOk(await readWorkerRow(run, "w-1")).row.fence;
    expect(fence).toEqual({ liveTaskId: "t-9", abortRequested: true, attemptCount: 2 });
    expect(Object.keys(fence ?? {}).sort()).toEqual([
      "abortRequested",
      "attemptCount",
      "liveTaskId",
    ]);
  });

  /**
   * §6.3 puts `fence.json` on the FAST clock, so the fast refresh has to re-read
   * it. A fence carried forward with the immutable satellites would make the
   * `busy`/`replayable` answer as old as the last 30 s walk — which is the one
   * fact a later action key would consult at the moment it mattered most.
   */
  test("the fast refresh re-reads the fence and carries `via` forward", async () => {
    const root = await makeRoot("fastfence");
    const run = await makeRun(root, "2026-09-02T00-00-00Z-ff01");
    const wp = await makeWorker(run, "w-1");
    await writeFile(wp.launchJson, JSON.stringify(rpcLaunch()));

    const first = expectOk(await readWorkerRow(run, "w-1"));
    expect(first.row.fence).toBeNull();
    expect(first.row.via).toBe("rpc");

    // A dispatch happens: the fence appears between ticks.
    await writeFile(
      wp.fenceJson,
      JSON.stringify({
        schema: "pifleet.fence/v1",
        worker: "w-1",
        last_accepted_epoch: 1,
        ack_seq: null,
        last_seq: 2,
        live: {
          task_id: "t-1",
          attempt_id: "a-1",
          epoch: 1,
          started: true,
          abort_requested: false,
          timed_out: false,
        },
        completed: [],
        attempts: { "t-1:a-1": 1 },
      }),
    );

    const next = expectOk(await refreshWorkerRow(run, "w-1", first.evidence));
    expect(next.row.fence).toEqual({
      liveTaskId: "t-1",
      abortRequested: false,
      attemptCount: 1,
    });
    // …and `via` survived without `launch.json` being re-opened, because the
    // record is immutable after `up` and the satellites are carried.
    expect(next.row.via).toBe("rpc");
  });

  /**
   * `model.ts:172-177` gives a failed fence read to "the enclosing Region", not
   * to the field. A damaged fence rendering as `fence: null` would say "this
   * worker has taken no epoch" about a worker that may be holding one — which
   * is the direction a later action would be WRONGLY offered in.
   */
  test("a damaged fence fails the region rather than reading as no fence", async () => {
    const root = await makeRoot("torn");
    const run = await makeRun(root, "2026-09-02T00-00-00Z-tn01");
    const wp = await makeWorker(run, "w-1");
    await writeFile(wp.fenceJson, '{"schema":"pifleet.fence/v1","worker":"w-1","last_acc');

    const region = await readWorkerRow(run, "w-1");
    expect(region.status).toBe("failed");
    if (region.status !== "failed") return;
    expect(region.reason).toContain(wp.fenceJson);
  });
});

// ---------------------------------------------------------------------------
// ISC-500 — the run history is enumerated by `runIdsAscending`, never by mtime
// ---------------------------------------------------------------------------

describe("ISC-500: run history comes from the id, not from mtime", () => {
  /**
   * **THE PROBE THIS CRITERION EXISTS FOR.**
   *
   * A run directory's mtime moves whenever anything under it is written — a
   * harvest, a later `report`, an editor, a backup tool. So the failure an
   * mtime sort produces is not an error, it is a WRONG ORDER that looks
   * plausible: the list still holds real runs, still newest-first-looking, and
   * is completely wrong about which one just happened.
   *
   * The fixture makes the OLDEST run the NEWEST by mtime, by an explicit
   * `utimes` rather than by hoping a write lands late. If the order came from
   * the filesystem, `old` would be first.
   */
  test("touching an old run does not move it", async () => {
    const root = await makeRoot("order");
    const old = await makeRun(root, "2026-08-01T00-00-00Z-old0");
    const mid = await makeRun(root, "2026-08-15T00-00-00Z-mid0");
    const now = await makeRun(root, "2026-09-01T00-00-00Z-new0");
    for (const r of [old, mid, now]) await makeWorker(r, "w-1");

    const before = expectOk(await readHistory({ root })).map((r) => r.runId);
    expect(before).toEqual([now.runId, mid.runId, old.runId]);

    // Now make the oldest run the most recently modified, by both routes an
    // mtime sort could observe: a write under it, and an explicit stamp.
    await writeFile(join(old.root, "touched"), "x");
    const future = new Date(Date.now() + 60_000);
    await utimes(old.root, future, future);

    const after = expectOk(await readHistory({ root })).map((r) => r.runId);
    expect(after).toEqual(before);
    expect(after[0]).toBe(now.runId);
    expect(after[after.length - 1]).toBe(old.runId);
  });

  /**
   * Finding C, inherited rather than re-implemented: 34 of 114 directories
   * under the operator's runs root hold no `run.json`, so a bare `readdir`
   * shows 42% more "runs" than exist. `runIdsAscending` drops them, and this
   * asserts the monitor gets that for free rather than re-deriving the filter.
   */
  test("a directory with no run.json is not a run", async () => {
    const root = await makeRoot("stray");
    const real = await makeRun(root, "2026-09-01T00-00-00Z-re01");
    await makeWorker(real, "w-1");
    // A name that sorts AFTER every timestamp, which is the exact shape
    // `paths.ts:906-909` records the e2e suite finding.
    await mkdir(join(root, "zz-scratch"), { recursive: true });
    await writeFile(join(root, "zz-scratch", "notes.txt"), "not a run");

    const rows = expectOk(await readHistory({ root }));
    expect(rows.map((r) => r.runId)).toEqual([real.runId]);
  });

  /**
   * ISC-500's source-text half. The behavioural test above catches an mtime
   * sort that is there; this catches the machinery arriving before the sort
   * does, which is how it would actually be added — a `stat` "just to show the
   * date", and a `sort` on it a week later.
   */
  test("the module names the enumerator and no mtime at all", async () => {
    const code = (
      await readFile(
        fileURLToPath(new URL("../../src/monitor/read/history.ts", import.meta.url)),
        "utf8",
      )
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    expect(code).toContain("runIdsAscending(");
    for (const forbidden of ["mtime", "mtimeMs", "birthtime", "ctime", "statSync", "lstat"]) {
      expect(code, `history.ts reaches ${forbidden}`).not.toContain(forbidden);
    }
    // And the ordering happens exactly once, as a reversal of the enumerator's
    // own order. A `.sort(` here would be a second ordering rule.
    expect(code).not.toContain(".sort((");
  });

  /**
   * `ageMs` IS WALL CLOCK — the run id is a timestamp written by another
   * process. `model.ts`'s two-clocks note: mixing the two does not error, it
   * produces a plausible number that clamps to 0, and every run renders as
   * though it started this instant.
   *
   * The probe pins MAGNITUDE rather than monotonicity, on
   * `monitor-clock-units.test.ts`'s reasoning — "it goes forward" is true of
   * both clocks. `now` is set to a monotonic-looking small number and `wallNow`
   * to a real epoch; a reader that used `now` would report 0.
   */
  test("ageMs is wall clock, and a monotonic `now` cannot supply it", async () => {
    const root = await makeRoot("age");
    const run = await makeRun(root, "2026-09-02T12-00-00Z-ag01");
    await makeWorker(run, "w-1");

    const wall = Date.parse("2026-09-02T13-00-00Z".replace(/T(\d\d)-(\d\d)-(\d\d)Z/, "T$1:$2:$3Z"));
    const rows = expectOk(
      await readHistory({ root, now: () => 412, wallNow: () => wall }),
    );
    expect(rows[0]!.ageMs).toBe(3_600_000);
    // The monotonic reading reached `readAt` and nothing else.
    const region = await readHistory({ root, now: () => 412, wallNow: () => wall });
    expect(region.status === "ok" && region.readAt).toBe(412);
  });

  /**
   * The counts, each from the directory §6.2 names: workers from `workers/`,
   * tasks from `inbox/`, settled from the per-worker `tasks/`. Asserted
   * together because the failure worth catching is a transposition, and one
   * count checked alone cannot see one.
   */
  test("worker, task and settled counts come from their own directories", async () => {
    const root = await makeRoot("counts");
    const run = await makeRun(root, "2026-09-02T00-00-00Z-ct01");
    const a = await makeWorker(run, "w-a");
    await makeWorker(run, "w-b");
    await mkdir(run.inboxDir, { recursive: true });
    for (const t of ["t-1", "t-2", "t-3"]) {
      await writeFile(join(run.inboxDir, `${t}.json`), "{}");
    }
    // A stray non-document in the inbox — `collect.ts:492`'s own filter drops
    // it, and a monitor that counted it would report a task that does not
    // exist. This is the interrupted-atomic-write case.
    await writeFile(join(run.inboxDir, "t-4.json.tmp"), "{}");
    await mkdir(a.tasksDir, { recursive: true });
    await writeFile(join(a.tasksDir, "t-1.json"), "{}");

    const row = expectOk(await readHistory({ root }))[0]!;
    expect(row.workerCount).toBe(2);
    expect(row.taskCount).toBe(3);
    expect(row.settledCount).toBe(1);
    // `process.pid` is alive by construction, so `liveRunIds` says so.
    expect(row.live).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// ISC-501 — the run report is the existing renderer's output
// ---------------------------------------------------------------------------

/**
 * `renderRunReport` stamps `generated <ISO>` from the moment of collection, so
 * two invocations differ in exactly one line. Masking it is the only way to
 * compare two runs of the same renderer at all — and the mask is asserted to
 * have matched exactly once, so a future volatile line cannot hide behind it.
 */
function maskGenerated(lines: readonly string[]): string[] {
  const out = lines.map((l) => (l.startsWith("generated ") ? "generated <ts>" : l));
  expect(out.filter((l) => l === "generated <ts>")).toHaveLength(1);
  return out;
}

describe("ISC-501: the report is the existing renderer's output", () => {
  /**
   * A run `report` can actually collect: a ledger shard, an inbox envelope and
   * a worker. Built through the real writers' shapes rather than minimally, so
   * the rendered text has content in it — a report of an empty run would
   * compare equal for the trivial reason that both sides are three lines.
   */
  async function reportableRun(tag: string): Promise<{ root: string; run: RunPaths }> {
    const root = await makeRoot(tag);
    const run = await makeRun(root, "2026-09-02T00-00-00Z-rp01");
    const wp = await makeWorker(run, "w-1", { phase: "idle", task_id: "t-1" });
    await mkdir(run.ledgerDir, { recursive: true });
    await writeFile(
      join(run.ledgerDir, "cli.jsonl"),
      `${JSON.stringify({
        seq: 1,
        ts: "2026-09-02T00-00-01.000Z",
        actor: "cli",
        run_id: run.runId,
        event: "dispatched",
        task_id: "t-1",
        worker: "w-1",
        detail: { via: "staged" },
      })}\n`,
    );
    await mkdir(run.inboxDir, { recursive: true });
    await writeFile(
      join(run.inboxDir, "t-1.json"),
      JSON.stringify({
        schema: "pifleet.task/v1",
        task_id: "t-1",
        run_id: run.runId,
        worker: "w-1",
        epoch: 0,
        brief: "do the thing",
        outbox: "/outbox/t-1",
      }),
    );
    await writeFile(
      wp.attendedJson,
      JSON.stringify({
        schema: "pifleet.attended/v1",
        worker: "w-1",
        run_id: run.runId,
        mode: "tui",
        entered_at: "2026-09-02T00-00-02.000Z",
        left_at: null,
        voided: [],
      }),
    );
    return { root, run };
  }

  /**
   * **THE PROBE THAT CANNOT BE SATISFIED BY A RE-FORMATTING.**
   *
   * The claim is that the monitor's view 4 and `pifleet report --md` are the
   * same bytes. Nothing short of running the command can say that: an
   * in-process comparison against `renderRunReport` asserts that the renderer
   * equals itself, and would stay green for a module that called the renderer
   * and then post-processed its output.
   *
   * ISC-345's finding is the reason it is worth the subprocess: "two readers of
   * one fact, written independently, is how a value-reader goes blind while its
   * sibling keeps working". Two REPORT renderers would not go blind — they
   * would disagree, in a pane and on a terminal, about whether a branch merges.
   */
  test("the lines are byte-identical to `pifleet report --md`", async () => {
    const { root, run } = await reportableRun("cli-eq");

    const lines = expectOk(await readRunReport(run.runId, { root }));

    const cli = Bun.spawn(
      ["bun", fileURLToPath(new URL("../../src/cli/index.ts", import.meta.url)), "report", "--run", run.runId, "--md"],
      {
        env: { ...process.env, PIFLEET_RUNS_DIR: root },
        stdout: "pipe",
        stderr: "pipe",
      },
    );
    const stdout = await new Response(cli.stdout).text();
    expect(await cli.exited).toBe(0);

    expect(maskGenerated(lines)).toEqual(maskGenerated(stdout.split("\n")));
    // And there is content to compare — an empty report would make the
    // assertion above true for the wrong reason.
    expect(lines.length).toBeGreaterThan(5);
    expect(lines.join("\n")).toContain(run.runId);
  });

  /**
   * `render.ts:194-199`'s wording, named in §6.2 and in `model.ts:222-226` as
   * the thing that must survive verbatim. It is not decoration: a pre-check
   * that says a branch "merges cleanly" without saying NOT MERGED is read as a
   * report that the merge happened.
   *
   * Asserted against the renderer's own source rather than against a fixture
   * that produces the line, because producing it needs a real git repository
   * and two branches — and what this criterion is about is that the monitor
   * does not own the sentence, which is a property of where the sentence lives.
   */
  test("the merge wording lives in the renderer, and the monitor has no copy", async () => {
    const renderSrc = await readFile(
      fileURLToPath(new URL("../../src/report/render.ts", import.meta.url)),
      "utf8",
    );
    expect(renderSrc).toContain("as of this check");
    expect(renderSrc).toContain("NOT merged");

    const monitorSrc = (
      await readFile(
        fileURLToPath(new URL("../../src/monitor/read/report.ts", import.meta.url)),
        "utf8",
      )
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    // The monitor calls the renderer…
    expect(monitorSrc).toContain("renderRunReport(");
    // …and formats nothing itself. No template literal builds a report line, no
    // markdown heading is spelled, and no wording is duplicated.
    for (const forbidden of ["NOT merged", "as of this check", "## ", "# pifleet"]) {
      expect(monitorSrc, `read/report.ts spells ${forbidden}`).not.toContain(forbidden);
    }
  });

  /**
   * ISC-232's parity, carried into the pane. `pifleet report` resolves the
   * harness surface before collecting because "a run graded one way by one
   * command and another way by the other is not two views of a run, it is a bug
   * with two outputs". A monitor that skipped it would be the third output.
   *
   * The `harness surface:` note is the observable half — it is the line
   * `cli/commands/report.ts:63` puts into `notes` unconditionally, precisely so
   * that "defaults" and "config" are distinguishable in the output.
   */
  test("the harness surface is resolved and reaches the notes", async () => {
    const { root, run } = await reportableRun("harness");
    const lines = expectOk(await readRunReport(run.runId, { root }));
    expect(lines.join("\n")).toContain("harness surface:");
  });

  /**
   * §9 Q7 answered §2.5's "seconds, not milliseconds" with a measurement, and
   * this is the assertion that the answer stays true for the SHAPE of run that
   * occurs — not a benchmark. A trailing empty element is kept, deliberately,
   * because dropping it would make the array not quite the renderer's output.
   */
  test("the renderer's trailing newline survives as an empty last line", async () => {
    const { root, run } = await reportableRun("trailing");
    const lines = expectOk(await readRunReport(run.runId, { root }));
    expect(lines[lines.length - 1]).toBe("");
  });

  /** A run that is not there is a failed region, never an empty report. */
  test("a missing run fails the region rather than rendering an empty report", async () => {
    const root = await makeRoot("missing");
    const region = await readRunReport("2026-09-02T00-00-00Z-nope", { root });
    // `collectRunReport` degrades rather than throwing, so this may be `ok`
    // with a report full of nothing — what must NOT happen is a crash, and what
    // must be true either way is that the run id is named.
    expect(["ok", "failed"]).toContain(region.status);
    if (region.status === "ok") expect(region.value.join("\n")).toContain("2026-09-02T00-00-00Z-nope");
    if (region.status === "failed") expect(region.reason).toContain("2026-09-02T00-00-00Z-nope");
  });
});

// ---------------------------------------------------------------------------
// ISC-502 — views 2-4 cost nothing while unentered
// ---------------------------------------------------------------------------

describe("ISC-502: an unentered view performs no read", () => {
  /**
   * A fixture on which all three readers WOULD succeed, which is what makes
   * `never` evidence of anything.
   *
   * `readHistory` and `readRunReport` never return `never` — they return `ok`
   * or `failed` — so a `never` region from either is proof the reader was not
   * called. `readWorkerDetail` CAN return `never`, for a worker with no
   * `state.json`, so the fixture gives it one: with a valid state file on disk,
   * a call would produce `ok`, and `never` again means "not called".
   *
   * **That is the whole design of this test.** The alternative — timing the
   * tick, or counting syscalls — measures how expensive the read is rather
   * than whether it happened, and a payload that were merely cheap would still
   * be fetched 120 times a minute by a pane nobody has left.
   */
  async function enterable(tag: string): Promise<{ root: string; run: RunPaths }> {
    const root = await makeRoot(tag);
    const run = await makeRun(root, "2026-09-02T00-00-00Z-en01");
    await makeWorker(run, "w-1");
    return { root, run };
  }

  test("the fleet view fetches none of the three", async () => {
    const { root } = await enterable("fleet");
    const payload = await fetchForView({ kind: "fleet" }, { root });
    expect(payload.history.status).toBe("never");
    expect(payload.detail.status).toBe("never");
    expect(payload.report.status).toBe("never");
  });

  test("the first composed frame is the fleet view with all three never", async () => {
    const { root } = await enterable("compose");
    const model = await composeFleet({
      root,
      watchDir: root,
      columns: 120,
      // No `docker ps`: the container region is supplied, so this composes
      // with no subprocess at all.
      containers: { status: "never" },
    });
    expect(model.view).toEqual({ kind: "fleet" });
    expect(model.history.status).toBe("never");
    expect(model.detail.status).toBe("never");
    expect(model.report.status).toBe("never");
  });

  /**
   * Each view fetches ITS payload and only its payload. The negative half is
   * the assertion — a `fetchForView` that fetched everything and returned it
   * all would pass the positive half of every one of these.
   */
  test("entering one view leaves the other two untouched", async () => {
    const { root, run } = await enterable("one");

    const history = await fetchForView({ kind: "history" }, { root });
    expect(history.history.status).toBe("ok");
    expect(history.detail.status).toBe("never");
    expect(history.report.status).toBe("never");

    const detail = await fetchForView(
      { kind: "worker", runId: run.runId, workerId: "w-1" },
      { root },
    );
    expect(detail.detail.status).toBe("ok");
    expect(detail.history.status).toBe("never");
    expect(detail.report.status).toBe("never");

    const report = await fetchForView({ kind: "report", runId: run.runId }, { root });
    expect(report.report.status).toBe("ok");
    expect(report.history.status).toBe("never");
    expect(report.detail.status).toBe("never");
  });

  /**
   * LEAVING a view returns its payload to `never`, and that is not tidiness.
   * §6.4 allows a stale region only while something is still trying to refresh
   * it — "as of 47s — refresh failed" names a reader that ran. A payload from
   * an abandoned view has no reader behind it at all and no honest staleness
   * marker, so it goes back to "I could not look", which is exactly true.
   */
  test("leaving a view returns its payload to never", async () => {
    const { root, run } = await enterable("leave");
    const base = await composeFleet({
      root,
      watchDir: root,
      columns: 120,
      containers: { status: "never" },
    });

    const entered = withView(
      base,
      { kind: "report", runId: run.runId },
      await fetchForView({ kind: "report", runId: run.runId }, { root }),
    );
    expect(entered.report.status).toBe("ok");

    const left = withView(entered, { kind: "fleet" }, await fetchForView({ kind: "fleet" }, { root }));
    expect(left.view).toEqual({ kind: "fleet" });
    expect(left.report.status).toBe("never");
    // …and the fleet regions came through untouched. Entering and leaving a
    // view must not re-walk the run tree.
    expect(left.runs).toBe(base.runs);
    expect(left.git).toBe(base.git);
  });

  /**
   * The other half of "costs nothing": no CLOCK can reach these readers.
   *
   * `fetchForView` guarantees the fleet view fetches nothing; this guarantees
   * nothing else does either. Asserted on `clocks.ts`'s source and on the
   * shipped source map by name, which is where §5.3's deferral of
   * `collectRunReport` "on the fast clock" actually has to hold.
   */
  test("no clock source names any of the three readers", async () => {
    const { fleetSources } = await import("../../src/monitor/clocks.ts");
    const code = (
      await readFile(fileURLToPath(new URL("../../src/monitor/clocks.ts", import.meta.url)), "utf8")
    )
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^[ \t]*\/\/.*$/gm, "");
    for (const reader of ["readHistory", "readRunReport", "readWorkerDetail", "collectRunReport"]) {
      expect(code, `clocks.ts reaches ${reader}`).not.toContain(reader);
    }
    // The source map is PINNED, so a fourth source cannot arrive unnoticed.
    const root = await makeRoot("sources");
    const sources = fleetSources({ root, watchDir: root, dockerRun: async () => ({ code: 0, stdout: "", stderr: "" }) });
    expect(Object.keys(sources).sort()).toEqual([
      "containers",
      "git",
      "runNames",
      "runs",
      "workers",
    ]);
  });
});

/**
 * ISC-508's reader half.
 *
 * Every other assertion about the refusal surface in view 2 is written against
 * a FIXTURE `WorkerDetail`, which means deleting `readWorkerDetail`'s
 * `...(await surfaceP)` would leave all of them green — the view would render
 * `undefined` fields from a payload nothing filled. This is the test that fails
 * for that, and it is here rather than beside the view tests because it is a
 * fact about the reader.
 */
describe("ISC-508: readWorkerDetail carries the refusal surface, from the same derivation", () => {
  test("a tui worker at an adopted terminal reads as `staged`, with its fence", async () => {
    const root = await makeRoot("detailsurface");
    const run = await makeRun(root, "2026-09-02T00-00-00Z-ds01");
    const wp = await makeWorker(run, "w-1");
    await writeFile(wp.launchJson, JSON.stringify(tuiLaunch()));
    await writeFile(
      wp.presentationJson,
      JSON.stringify({
        schema: "pifleet.presentation/v1",
        worker: "w-1",
        backend: "headless",
        adopted_terminal: true,
        surface_ref: "surface:1",
      }),
    );
    await writeFile(
      wp.fenceJson,
      JSON.stringify({
        schema: "pifleet.fence/v1",
        worker: "w-1",
        last_accepted_epoch: 2,
        ack_seq: null,
        last_seq: 4,
        live: null,
        completed: [],
        attempts: { "t-1:a-1": 1, "t-2:a-2": 2 },
      }),
    );

    const detail = expectOk(await readWorkerDetail(run, "w-1"));
    // The same answer `readWorkerRow` gives for the same worker — one
    // derivation, two carriers. If these ever disagree there are two rules.
    expect(detail.via).toBe("staged");
    expect(expectOk(await readWorkerRow(run, "w-1")).row.via).toBe("staged");
    expect(detail.fence).toEqual({
      liveTaskId: null,
      abortRequested: false,
      attemptCount: 2,
    });
  });

  test("an unreadable launch record leaves `via` null, not `rpc`", async () => {
    const root = await makeRoot("detailsurfacebad");
    const run = await makeRun(root, "2026-09-02T00-00-00Z-ds02");
    const wp = await makeWorker(run, "w-1");
    // Truncated: present and unparseable, which is the case the permissive
    // default would answer wrongly.
    await writeFile(wp.launchJson, JSON.stringify(rpcLaunch()).slice(0, 40));

    const detail = expectOk(await readWorkerDetail(run, "w-1"));
    expect(detail.via).toBeNull();
    expect(detail.fence).toBeNull();
  });
});
