/**
 * The two orderings a console's `--restart` is made of.
 *
 * `recreateThenDispatch` is the `--task` half — recreate-then-dispatch, and the
 * rule that it must never recreate over work. `resolveThenRestart` is the bare
 * half — resolve the pane, stop the runs holding the worker, respawn it — and
 * its tests live at the bottom of this file for the reason its docblock gives:
 * the two are siblings, they are ordered by the same convention, and the
 * ordering is the only thing either of them can get wrong.
 *
 * The ordering assertions carry the weight here. A recreate destroys the
 * worker's container, supervisor and worktree, so "did it wait?" and "did it
 * stop anything before refusing?" are not style questions — they are the
 * difference between a fresh session and a deleted task. Every refusal test
 * below therefore also asserts that `down` and `restartPane` were never
 * called, because a refusal that has already torn something down is not a
 * refusal.
 *
 * The staged case is the one that motivated the module. Measured 2026-09-04,
 * `tst-1` sat with `phase: "idle"`, `task_id: null` and a `staged_task_id` —
 * an envelope it had accepted and not yet run. Anything reading only `phase`
 * or only `task_id` calls that worker free and recreates over a task the
 * operator had already handed it.
 */
import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  busyRefusal,
  recreateThenDispatch,
  resolveThenRestart,
  settledEnough,
  workerActivity,
  type ConsoleRestartDeps,
  type FreshDispatchDeps,
} from "../../src/run/fresh-dispatch.ts";

interface WorkerRow {
  id: string;
  alive?: boolean;
  phase?: string;
  task_id?: string | null;
  staged_task_id?: string | null;
}

const status = (runs: Array<{ run_id: string; workers: WorkerRow[] }>): string =>
  JSON.stringify({
    runs: runs.map((r) => ({
      run_id: r.run_id,
      workers: r.workers.map((w) => ({
        alive: true,
        phase: "idle",
        task_id: null,
        staged_task_id: null,
        ...w,
      })),
    })),
  });

const IDLE = status([{ run_id: "run-old", workers: [{ id: "tst-1" }] }]);
const FRESH = status([{ run_id: "run-new", workers: [{ id: "tst-1" }] }]);

interface Harness {
  deps: FreshDispatchDeps;
  calls: string[];
}

/**
 * `reads` is consumed one entry per `status()` call; the last one repeats.
 *
 * `relay` says whether this console has a fifth process, which is the same
 * thing the `quiesce` dep says and the reason that dep is nullable rather than
 * optional. It defaults to the `null` console because most of the assertions
 * below are about the recreate itself; the ones that are about the relay say
 * `{ relay: true }` and read as such.
 */
function harness(reads: string[], o: { relay?: boolean } = {}): Harness {
  const calls: string[] = [];
  let i = 0;
  let clock = 0;
  return {
    calls,
    deps: {
      status: async () => {
        const r = reads[Math.min(i, reads.length - 1)] ?? IDLE;
        i += 1;
        calls.push("status");
        return r;
      },
      quiesce: o.relay === true ? async () => void calls.push("stopRelay") : null,
      down: async (runId) => {
        calls.push(`down:${runId}`);
      },
      restartPane: async () => {
        calls.push("restartPane");
      },
      dispatch: async (runId) => {
        calls.push(`dispatch:${runId}`);
        // The real payload's shape, not a placeholder sentence. `dispatch
        // --json` answers with `accepted`, and this function now READS it —
        // a fixture that returned prose was the reason it could not have.
        return JSON.stringify({ accepted: true, task_id: "T-1", via: "staged", run_id: runId });
      },
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
    },
  };
}

/**
 * ── THE DISPATCH THAT WAS REPORTED AND NEVER HAPPENED ──────────────────────
 *
 * MEASURED on the live console. `scripts/review` wires the `dispatch` dep to a
 * helper whose own docblock says it runs a subcommand "swallowing failure",
 * with `stderr: "ignore"` so the reason goes too. A task envelope was refused
 * by the validator — a short SHA where a 40-character one is required —
 * `dispatch` exited 2, the helper returned `""`, and the console printed
 * "recreated col-1 into run <id> ... and dispatched <path>" and exited 0.
 * Nothing reached the inbox and the operator waited for a review that could
 * never run.
 *
 * The check lives in this function rather than in the caller's wrapper for the
 * reason the relay's dispatch path already records: `accepted` alone does not
 * answer whether it happened, and neither does a caller's choice of subprocess
 * helper. Any caller wiring any runner gets the guarantee here.
 */
describe("recreateThenDispatch refuses to report a dispatch that did not land", () => {
  const landed = async (dispatchOut: string) => {
    const { deps } = harness([status([]), FRESH]);
    return await recreateThenDispatch(
      { ...deps, dispatch: async () => dispatchOut },
      { worker: "tst-1", pollMs: 1, readyTimeoutMs: 1000 },
    ).then(
      (r) => ({ ok: true as const, r }),
      (e: unknown) => ({ ok: false as const, msg: e instanceof Error ? e.message : String(e) }),
    );
  };

  test("empty output — what a runner that discards a failing exit returns", async () => {
    const got = await landed("");
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.msg).toContain("DID NOT LAND");
    expect(got.msg).toContain("no output at all");
    // The refusal names what was ALREADY done: by this point the old runs are
    // stopped and the pane has been respawned, and an operator told only
    // "dispatch failed" would not know whether the fleet had been touched.
    expect(got.msg).toContain("was recreated into run run-new");
  });

  test("a supervisor refusal exits 0 and is caught anyway", async () => {
    // The arm a non-zero exit check would miss entirely: the CLI succeeded and
    // the SUPERVISOR declined — a stale epoch, an id already held.
    const got = await landed(JSON.stringify({ accepted: false, reason: "stale_epoch" }));
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.msg).toContain("refused");
    expect(got.msg).toContain("stale_epoch");
  });

  test("output that is not JSON is named as such, with the text", async () => {
    const got = await landed("pifleet: invalid task envelope: base_ref must be a full 40-char SHA");
    expect(got.ok).toBe(false);
    if (got.ok) return;
    expect(got.msg).toContain("not the JSON --json promises");
    expect(got.msg).toContain("40-char SHA");
  });

  test("an accepted dispatch passes through unchanged", async () => {
    // The control. Without it every assertion above is satisfied by a function
    // that refuses everything.
    const payload = JSON.stringify({ accepted: true, task_id: "T-1", via: "staged" });
    const got = await landed(payload);
    expect(got.ok).toBe(true);
    if (!got.ok) return;
    expect(got.r.dispatched).toBe(payload);
    expect(got.r.runId).toBe("run-new");
  });
});

describe("reading one worker's activity out of a fleet status", () => {
  test("a worker in no run has no activity", () => {
    expect(workerActivity(status([]), "tst-1")).toEqual([]);
  });

  test("a worker present in two runs yields both", () => {
    const a = workerActivity(
      status([
        { run_id: "r1", workers: [{ id: "tst-1" }] },
        { run_id: "r2", workers: [{ id: "tst-1", task_id: "T-9" }] },
      ]),
      "tst-1",
    );
    // Collapsing to the first entry would miss the task running in the second.
    expect(a.map((x) => x.runId)).toEqual(["r1", "r2"]);
  });

  test("unreadable status throws rather than reporting 'not busy'", () => {
    // The safe direction here is the opposite of `runsHoldingAny`'s: no
    // evidence must not green-light a teardown.
    expect(() => workerActivity("not json", "tst-1")).toThrow(/state is unknown/);
  });

  test("status with no runs array throws", () => {
    expect(() => workerActivity(JSON.stringify({}), "tst-1")).toThrow(/no runs array/);
  });
});

describe("what counts as settled", () => {
  const at = (o: Partial<ReturnType<typeof workerActivity>[number]>) => ({
    runId: "r",
    phase: "idle",
    taskId: null,
    stagedTaskId: null,
    alive: true,
    ...o,
  });

  test("idle with nothing held is settled", () => {
    expect(settledEnough(at({}))).toBe(true);
  });

  test("a running task is not settled", () => {
    expect(settledEnough(at({ taskId: "T-1", phase: "busy" }))).toBe(false);
  });

  test("a STAGED task is not settled, even though the phase reads idle", () => {
    // The measured shape. `phase` and `task_id` both say free; the worker is
    // holding an envelope it has accepted.
    expect(settledEnough(at({ phase: "idle", taskId: null, stagedTaskId: "T-3" }))).toBe(false);
  });

  test("an unrecognised phase is treated as busy, not as free", () => {
    expect(settledEnough(at({ phase: "unknown" }))).toBe(false);
  });
});

describe("a busy worker is waited for, and never recreated over", () => {
  test("it waits for a running task to finish, then recreates", async () => {
    const busy = status([{ run_id: "run-old", workers: [{ id: "tst-1", phase: "busy", task_id: "T-1" }] }]);
    const h = harness([busy, busy, IDLE, FRESH]);
    const r = await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 1000 });

    expect(r.runId).toBe("run-new");
    expect(r.settleWaitMs).toBe(2000);
    // Nothing was torn down until after the task cleared.
    const firstDown = h.calls.indexOf("down:run-old");
    const lastBusyRead = 2; // two busy status reads precede the idle one
    expect(firstDown).toBeGreaterThan(lastBusyRead);
  });

  test("it waits for a STAGED task too, and the wait is observable", async () => {
    /*
     * The elapsed assertion is what makes this test discriminating. Written
     * only as "down was called, dispatch was called" it passed with the staged
     * check REMOVED — proceeding immediately reaches the same two calls. A
     * recreate that did not wait is the defect, so the wait itself is what
     * gets asserted.
     */
    const staged = status([{ run_id: "run-old", workers: [{ id: "tst-1", staged_task_id: "T-3" }] }]);
    const h = harness([staged, staged, IDLE, FRESH]);
    const r = await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 500 });
    expect(r.settleWaitMs).toBe(1000);
    expect(h.calls).toContain("down:run-old");
    expect(h.calls).toContain("dispatch:run-new");
  });

  test("a staged task that never clears REFUSES, having stopped nothing", async () => {
    const staged = status([{ run_id: "run-old", workers: [{ id: "tst-1", staged_task_id: "T-3" }] }]);
    const h = harness([staged]);
    await expect(
      recreateThenDispatch(h.deps, { worker: "tst-1", settleTimeoutMs: 4_000, pollMs: 1000 }),
    ).rejects.toThrow(/staged T-3/);
    expect(h.calls.filter((c) => c.startsWith("down:"))).toEqual([]);
    expect(h.calls).not.toContain("restartPane");
  });

  test("a task that never finishes REFUSES, having stopped nothing", async () => {
    const busy = status([{ run_id: "run-old", workers: [{ id: "tst-1", phase: "busy", task_id: "T-1" }] }]);
    const h = harness([busy]);
    await expect(
      recreateThenDispatch(h.deps, { worker: "tst-1", settleTimeoutMs: 5_000, pollMs: 1000 }),
    ).rejects.toThrow(/still holds work/);

    // The whole point: a refusal that already tore something down is not one.
    expect(h.calls.filter((c) => c.startsWith("down:"))).toEqual([]);
    expect(h.calls).not.toContain("restartPane");
    expect(h.calls.filter((c) => c.startsWith("dispatch:"))).toEqual([]);
  });

  test("the refusal names the task and how to end it", () => {
    const msg = busyRefusal("tst-1", [
      { runId: "r1", phase: "busy", taskId: "T-1", stagedTaskId: null, alive: true },
    ]);
    expect(msg).toContain("T-1");
    expect(msg).toContain("Nothing has been stopped");
    expect(msg).toContain("pifleet abort");
  });

  test("a refusal on unreadable status stops nothing either", async () => {
    const h = harness(["not json"]);
    await expect(recreateThenDispatch(h.deps, { worker: "tst-1" })).rejects.toThrow(
      /state is unknown/,
    );
    expect(h.calls.filter((c) => c.startsWith("down:"))).toEqual([]);
  });
});

describe("the order of a clean recreate", () => {
  test("status, down, respawn, then dispatch — in that order", async () => {
    const h = harness([IDLE, FRESH]);
    await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 100 });
    const seq = h.calls.filter((c) => c !== "status");
    expect(seq).toEqual(["down:run-old", "restartPane", "dispatch:run-new"]);
  });

  test("the dispatch goes to the NEW run, never the stopped one", async () => {
    const h = harness([IDLE, FRESH]);
    const r = await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 100 });
    expect(r.stopped).toEqual(["run-old"]);
    expect(h.calls).toContain("dispatch:run-new");
    expect(h.calls).not.toContain("dispatch:run-old");
  });

  test("a run id that reappears unchanged is not accepted as the fresh one", async () => {
    // The stopped run's directory outlives its supervisor, so a status read
    // that still lists it must not be mistaken for the replacement.
    const h = harness([IDLE, IDLE, IDLE]);
    await expect(
      recreateThenDispatch(h.deps, { worker: "tst-1", readyTimeoutMs: 3_000, pollMs: 1000 }),
    ).rejects.toThrow(/did not come back/);
    expect(h.calls.filter((c) => c.startsWith("dispatch:"))).toEqual([]);
  });

  test("a worker that registers but is not alive yet is waited for", async () => {
    const notYet = status([{ run_id: "run-new", workers: [{ id: "tst-1", alive: false }] }]);
    const h = harness([IDLE, notYet, notYet, FRESH]);
    const r = await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 1000 });
    expect(r.runId).toBe("run-new");
  });

  test("a worker with no run at all needs no teardown and still dispatches", async () => {
    // rev-1's shape after a failed recreate: no run, no container, nothing to
    // wait for and nothing to stop.
    const h = harness([status([]), FRESH]);
    const r = await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 100 });
    expect(r.stopped).toEqual([]);
    expect(h.calls.filter((c) => c.startsWith("down:"))).toEqual([]);
    expect(r.runId).toBe("run-new");
  });
});

/**
 * ── THE RELAY, AND THE REFUSAL THAT HAD ALREADY SPENT IT ───────────────────
 *
 * `scripts/review` runs a fifth process whose whole configuration is run ids —
 * `--run <id>` for the collator, a `PIFLEET_RELAY_RUNS` pin for the other three,
 * both fixed for the life of the process — so a recreate has to stop it, and a
 * relay left pointing at a dead run polls forever in silence.
 *
 * The script used to stop it ITSELF, on the line before this module was called.
 * That put the only unrecoverable step of the `--task` path ABOVE a wait that
 * lasts up to twenty minutes and then REFUSES, and the refusal it printed —
 * *"Nothing has been stopped"* — was false on that console: the fifth process
 * was already gone. What an operator was left holding was four healthy workers
 * and nothing able to turn a collator's dispatch request into reviews, after a
 * command that told them nothing had happened.
 *
 * So the relay stop is a dep here, exactly as it already was for
 * `resolveThenRestart`, and WHEN it fires is checked below rather than by
 * reading a script.
 */
describe("the relay is stopped after the wait, and never on a refusal", () => {
  const BUSY = status([
    { run_id: "run-old", workers: [{ id: "tst-1", phase: "busy", task_id: "T-1" }] },
  ]);

  /**
   * THE INVARIANT — and both halves of it are one test on purpose.
   *
   * The refusal's call list alone proves nothing. Before the fix this module
   * had no `quiesce` dep at all, so "the relay was not stopped" was true of the
   * refusal AND of the success path, and an assertion that only looked at the
   * refusal was green on the defect it exists to catch. What makes it a claim
   * about ORDER rather than about absence is the second list: the same harness,
   * the same relay, a worker that settles — and there the stop is present. One
   * without the other is a fixture that cannot fail.
   */
  test("a settle-timeout refusal leaves the relay RUNNING", async () => {
    const refused = harness([BUSY], { relay: true });
    await expect(
      recreateThenDispatch(refused.deps, {
        worker: "tst-1",
        settleTimeoutMs: 2_000,
        pollMs: 1_000,
      }),
    ).rejects.toThrow(/still holds work/);
    /*
     * Three reads and NOTHING else — the first, and one after each of the two
     * polls a 2s budget affords. An exact list rather than three
     * `not.toContain`s, because the list is also what says no side effect
     * added to a future phase 1 can slip in above the refusal.
     */
    expect(refused.calls).toEqual(["status", "status", "status"]);

    const settled = harness([IDLE, FRESH], { relay: true });
    await recreateThenDispatch(settled.deps, { worker: "tst-1", pollMs: 100 });
    expect(settled.calls).toEqual([
      "status",
      "stopRelay",
      "down:run-old",
      "restartPane",
      "status",
      "dispatch:run-new",
    ]);
  });

  test("a worker that settles LATE keeps its relay for the whole wait", async () => {
    /*
     * The discriminating shape, and the one the invariant is really about. A
     * worker that is already idle on the first read cannot tell a relay stopped
     * after the wait from one stopped before it — both produce a stop near the
     * top of the list. Here the wait takes two polls, so the position of
     * `stopRelay` in the sequence is the answer: after every busy read, before
     * the teardown that invalidates the ids it pins, and before the respawn.
     */
    const h = harness([BUSY, BUSY, IDLE, FRESH], { relay: true });
    const r = await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 1_000 });
    expect(r.settleWaitMs).toBe(2_000);
    expect(h.calls).toEqual([
      "status",
      "status",
      "status",
      "stopRelay",
      "down:run-old",
      "restartPane",
      "status",
      "dispatch:run-new",
    ]);
  });

  test("a console with no relay says so with null, and nothing else moves", async () => {
    // `operations` and `development` have no fifth process. The field is
    // required and nullable so they have to say which they are.
    const h = harness([IDLE, FRESH], { relay: false });
    await recreateThenDispatch(h.deps, { worker: "tst-1", pollMs: 100 });
    expect(h.calls).toEqual([
      "status",
      "down:run-old",
      "restartPane",
      "status",
      "dispatch:run-new",
    ]);
  });
});

/**
 * ── THE BARE `--restart`, AND THE REFUSAL THAT ARRIVED TOO LATE ────────────
 *
 * MEASURED 2026-09-06. `./scripts/operations --restart obs-1` printed, in this
 * order:
 *
 *   operations: stopping run 2026-09-04T18-03-52Z-e2fc before restarting obs-1
 *   operations: 'obs-1' is not a pane this console plans — it holds observer, monitor, ticketing
 *
 * Both operations workers were left DOWN with nothing respawned. The refusal was
 * correct and already tested; it simply arrived after the only irreversible
 * step, because the teardown keys on WORKER ID and the respawn keys on PANE
 * TITLE, and on that console those namespaces are disjoint.
 *
 * These tests assert the ORDER of the four side effects rather than the source
 * text of the scripts that supply them, which is the difference between
 * checking the fix and checking that somebody typed a function name. Every one
 * of them would have reddened on the console that produced the two lines above.
 */
describe("resolveThenRestart puts the resolution ahead of every irreversible step", () => {
  const HELD = JSON.stringify({
    runs: [
      // ASYMMETRIC on purpose. A fixture where every run holds the named worker
      // cannot tell a scoped teardown from a sweep, so the second run here is
      // another console's and must survive.
      { run_id: "run-old", workers: [{ id: "tst-1", alive: true }] },
      { run_id: "run-theirs", workers: [{ id: "obs-1", alive: true }] },
    ],
  });
  const NONE = JSON.stringify({ runs: [] });

  const REFUSAL =
    "operations: 'obs-1' is not a pane this console plans — it holds observer, monitor, ticketing";

  function restartHarness(
    o: { statusJson?: string; relay?: boolean; plannable?: boolean } = {},
  ): { calls: string[]; deps: ConsoleRestartDeps<string> } {
    const calls: string[] = [];
    return {
      calls,
      deps: {
        plan: () => {
          calls.push("plan");
          if (o.plannable === false) throw new Error(REFUSAL);
          return { title: "the pane" };
        },
        status: async () => {
          calls.push("status");
          return o.statusJson ?? HELD;
        },
        quiesce: o.relay === true ? async () => void calls.push("stopRelay") : null,
        down: async (runId) => void calls.push(`down:${runId}`),
        restartPane: async () => {
          calls.push("restartPane");
          return "surf-1";
        },
      },
    };
  }

  test("the whole sequence — resolve, quiesce, read status, stop, respawn", async () => {
    const h = restartHarness({ relay: true });
    const r = await resolveThenRestart(h.deps, { worker: "tst-1" });
    expect(h.calls).toEqual(["plan", "stopRelay", "status", "down:run-old", "restartPane"]);
    expect(r.stopped).toEqual(["run-old"]);
    expect(r.pane).toBe("surf-1");
  });

  test("an unplannable title stops NOTHING — not the run, not the relay", async () => {
    /*
     * The measured failure, asserted as an exact call list rather than as three
     * `not.toContain`s: a list is also what says no status was even read, and a
     * side effect added to a future phase 1 cannot slip past it.
     */
    const h = restartHarness({ relay: true, plannable: false });
    await expect(resolveThenRestart(h.deps, { worker: "obs-1" })).rejects.toThrow(
      /not a pane this console plans/,
    );
    expect(h.calls).toEqual(["plan"]);
  });

  test("the run is stopped BEFORE the pane is respawned", async () => {
    /*
     * The orphan-container rule. Respawning first kills the pane's shell, and
     * the supervisor it launched — which owns a detached container — is
     * signalled by the dying shell rather than told to quiesce.
     *
     * Both calls are asserted PRESENT before their indices are compared:
     * `indexOf` returns -1 for a call that never happened, and -1 is less than
     * everything, so an ordering assertion on its own passes loudest when the
     * teardown has been deleted outright.
     */
    const h = restartHarness();
    await resolveThenRestart(h.deps, { worker: "tst-1" });
    expect(h.calls).toContain("down:run-old");
    expect(h.calls).toContain("restartPane");
    expect(h.calls.indexOf("down:run-old")).toBeLessThan(h.calls.indexOf("restartPane"));
  });

  test("the relay is stopped before the runs go down, because it pins their ids", async () => {
    // `--run <id>` for the collator and `PIFLEET_RELAY_RUNS` for the other
    // three, both fixed for the life of the process.
    const h = restartHarness({ relay: true });
    await resolveThenRestart(h.deps, { worker: "tst-1" });
    expect(h.calls).toContain("stopRelay");
    expect(h.calls).toContain("down:run-old");
    expect(h.calls.indexOf("stopRelay")).toBeLessThan(h.calls.indexOf("down:run-old"));
    expect(h.calls.indexOf("stopRelay")).toBeLessThan(h.calls.indexOf("restartPane"));
  });

  test("the relay is NOT stopped when the title is refused", async () => {
    // The half a refusal gets wrong. On `review` a mistyped title would
    // otherwise take the actor down and leave four healthy workers with nothing
    // able to turn a dispatch request into reviews.
    const h = restartHarness({ relay: true, plannable: false });
    await expect(resolveThenRestart(h.deps, { worker: "obs-1" })).rejects.toThrow(REFUSAL);
    expect(h.calls).not.toContain("stopRelay");
  });

  test("a console with no relay says so with null, and nothing else moves", async () => {
    const h = restartHarness({ relay: false });
    await resolveThenRestart(h.deps, { worker: "tst-1" });
    expect(h.calls).toEqual(["plan", "status", "down:run-old", "restartPane"]);
  });

  test("only runs holding THIS worker are stopped", async () => {
    // The other console's run is somebody else's; a rebuild that swept it would
    // leave their panes attached to runs that no longer exist.
    const h = restartHarness();
    const r = await resolveThenRestart(h.deps, { worker: "tst-1" });
    expect(r.stopped).toEqual(["run-old"]);
    expect(h.calls).not.toContain("down:run-theirs");
  });

  test("a title no run holds — a watch pane — is respawned with nothing stopped", async () => {
    // `fleet-status`, `git-watch` and the monitor are panes and not workers, so
    // a restart of one must respawn and stop nothing.
    const h = restartHarness({ statusJson: NONE });
    const r = await resolveThenRestart(h.deps, { worker: "git-watch" });
    expect(r.stopped).toEqual([]);
    expect(h.calls).toEqual(["plan", "status", "restartPane"]);
  });

  test("unreadable status stops nothing and still brings the pane back", async () => {
    /*
     * The OPPOSITE direction from `workerActivity`, deliberately, and both are
     * right. There, no evidence must not green-light destroying a task, so it
     * throws. Here the caller is a launcher: containers left running are
     * untidy, and a console that refuses to come back is not. `runsHoldingAny`
     * documents the same choice.
     */
    const h = restartHarness({ statusJson: "not json" });
    const r = await resolveThenRestart(h.deps, { worker: "tst-1" });
    expect(r.stopped).toEqual([]);
    expect(h.calls).toContain("restartPane");
    expect(h.calls.filter((c) => c.startsWith("down:"))).toEqual([]);
  });
});

/**
 * ── THE FOURTH CONSOLE'S FIFTH PROCESS, READ OUT OF THE FILE ───────────────
 *
 * Everything above this line drives the two modules directly, which is the
 * right way to check an ORDER. None of it can answer whether a console script
 * supplies the dep at all, and on `scripts/` nothing else can either: ISC-600
 * measured it — `tsconfig.json`'s `include` is `src/**` and `test/**`, the
 * scripts run `main()` at import so no test can pull one into the program, and
 * **every mutation applied to `scripts/review` survived a fully green suite**,
 * including one that made the review script write the triage console's record.
 *
 * So this block reads the working tree. Three things are asked of it, and the
 * first two are one claim split in half because half of it is satisfiable by
 * accident.
 *
 * ## 1. `null` IS A LIE ON THIS CONSOLE, AND THE MIRROR IS WHAT PROVES IT
 *
 * `FreshDispatchDeps.quiesce` is required and nullable so that a console with no
 * actor must SAY so. That makes `quiesce: null` compile everywhere, and on a
 * console that has an actor it is the ISC-572 defect wearing the fix's clothes:
 * the property is present, `console-restart.test.ts`'s handover arm is green,
 * and the actor is never stopped at all. SRD-TRIAGE-CONSOLE §6.4 fixes which
 * console is which — *"`scripts/operations` and `scripts/development` pass
 * `null`; `review` passes a function; `triage` passes a function"* — so the
 * assertion is a PARTITION over the four scripts rather than a property of one.
 *
 * Asserting only "triage does not say null" would be green on a `scripts/triage`
 * that had no `quiesce` at all, and asserting only "operations says null" would
 * be green on a repository where nobody had ever written a non-null one. Both
 * halves, over an asymmetric set, is the shape that cannot pass on a fixture
 * that agrees with itself.
 *
 * ## 2. A DEP THAT STOPS NOTHING IS ALSO A LIE
 *
 * `quiesce: async () => {}` satisfies every arm above. So the binding is
 * followed to the function it names and that function to the signal it sends: a
 * stop that never reaches `signalRelay` leaves the actor running exactly as
 * `null` would, and the operator is told it was stopped.
 *
 * ## 3. THE ACTOR IT STOPS MUST BE THIS CONSOLE'S
 *
 * This is the arm that belongs here rather than anywhere else, and the reason is
 * the whole point of the block: an ordering that is impeccable about the WRONG
 * process is not a fixed console. `consoleRelayArgv` spells no `--console`, and
 * `DEFAULT_CONSOLE = "review"` — so a `scripts/triage` that spawned its argv
 * unchanged would start a REVIEW actor, hand `recreateThenDispatch` a `quiesce`
 * that correctly stops it, and leave the triage console with no actor while the
 * review console silently lost its own. That is §9.13's row reached through the
 * one caller that did not exist when §9.13 was written, and the call site is in
 * a file the compiler never opens.
 */
describe("scripts/triage's fifth process, which nothing typechecks (ISC-600)", () => {
  const source = (script: string): Promise<string> =>
    readFile(join(import.meta.dir, "..", "..", "scripts", script), "utf8");

  /** Where `needle` next appears, THROWING when it does not — `at`'s reason. */
  const at = (src: string, needle: string, from: number, why: string): number => {
    const i = src.indexOf(needle, from);
    if (i === -1) throw new Error(`'${needle}' is not in this script after ${from} — ${why}`);
    return i;
  };

  /**
   * The `quiesce` property lines of one module call's dep object.
   *
   * LINES whose trimmed text BEGINS with the property name, so a comment saying
   * `quiesce,` cannot stand in for the property — ISC-572's recorded hole, which
   * narrowing the span moved rather than closed.
   */
  const quiesceProps = (src: string, call: string, script: string): string[] => {
    const start = at(src, call, 0, `scripts/${script} does not call ${call}`);
    const end = at(
      src,
      "{ worker: restartFlag },",
      start,
      `scripts/${script}'s ${call} dep object is not closed by the options argument`,
    );
    return src
      .slice(start, end)
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.startsWith("quiesce"));
  };

  const MODULE_CALLS = ["recreateThenDispatch(", "resolveThenRestart("];

  test("both of its module calls are handed a stop, and neither of them is null", async () => {
    const src = await source("triage");
    for (const call of MODULE_CALLS) {
      const props = quiesceProps(src, call, "triage");
      expect(props.length).toBeGreaterThan(0);
      for (const p of props) expect(p).not.toContain("null");
    }
  });

  test("the two consoles with no actor still SAY null, which is what makes that a claim", async () => {
    // The asymmetric half. Without it "triage's quiesce is not null" is a
    // sentence about a repository in which nothing is ever null.
    for (const script of ["operations", "development"]) {
      const src = await source(script);
      for (const call of MODULE_CALLS) {
        const props = quiesceProps(src, call, script);
        expect(props).toEqual(["quiesce: null,"]);
      }
    }
  });

  test("the stop it hands over reaches a signal, not an empty function", async () => {
    const src = await source("triage");

    // The binding, followed to the helper it names.
    const bind = at(src, "const quiesce =", 0, "scripts/triage binds no quiesce at all");
    const bindEnd = at(src, ";", bind, "the quiesce binding is unterminated");
    expect(src.slice(bind, bindEnd)).toContain("stopActor(");

    // The helper, followed to the signal. A stop that never signals leaves the
    // actor running exactly as `null` would, and says it did not.
    const fn = at(src, "function stopActor(", 0, "scripts/triage defines no stopActor");
    const body = src.slice(fn, at(src, "\n}", fn, "stopActor is unterminated"));
    expect(body).toContain("signalRelay(");
    expect(body).toContain("relayRecordPath(CONSOLE)");
  });

  test("the actor it starts is served --console triage, and never a bare literal", async () => {
    const src = await source("triage");

    // Declared once, as a constant. The known-limit arm of ISC-600: a comment
    // carrying this literal satisfies it, which is why every arm below reads
    // structure instead.
    expect(src).toContain('const CONSOLE = "triage";');

    const fn = at(
      src,
      "function triageActorArgv(",
      0,
      "scripts/triage builds no actor argv of its own — spawning consoleRelayArgv's " +
        "unchanged would start a REVIEW actor, because DEFAULT_CONSOLE is \"review\"",
    );
    const body = src.slice(fn, at(src, "\n}", fn, "triageActorArgv is unterminated"));
    expect(body).toContain("consoleRelayArgv(");
    expect(body).toMatch(/"--console",\s*CONSOLE/);
    // Never `"--console", "triage"`: the constant is what keeps this file's five
    // console-shaped facts one fact.
    expect(body).not.toMatch(/"--console",\s*"/);

    /*
     * And the ACTOR'S OWN spawn is given that argv. Anchored inside
     * `startActor` rather than on the first `Bun.spawn(` in the file, which is
     * an ordering accident: `runOutput` and `runChecked` spawn too, and a probe
     * that happened to read one of those would be green with the actor's argv
     * replaced.
     */
    const start = at(src, "function startActor(", 0, "scripts/triage starts no actor");
    const spawn = at(src, "Bun.spawn(", start, "startActor spawns nothing");
    expect(src.slice(spawn, spawn + 40)).toContain("triageActorArgv(");
  });

  test("every bookkeeping path in it is taken through the same constant", async () => {
    // `console-relay.ts`'s three path functions are the review console's lock,
    // record and log when handed the wrong name — §9.13, and the symptom is a
    // review console that silently stops fanning out.
    const src = await source("triage");
    for (const fn of ["relayRecordPath", "relayLogPath", "relayLockPath"]) {
      const calls = [...src.matchAll(new RegExp(`${fn}\\(([^)]*)\\)`, "g"))];
      if (calls.length === 0) {
        throw new Error(`${fn} is called nowhere in scripts/triage — the wiring is gone, not fixed`);
      }
      for (const c of calls) expect(`${fn}(${c[1]})`).toBe(`${fn}(CONSOLE)`);
    }
  });
});
