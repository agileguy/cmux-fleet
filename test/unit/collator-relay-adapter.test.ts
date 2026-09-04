/**
 * The PRODUCTION ADAPTER behind `src/run/relay.ts` — `consoleFanOut`, the
 * transport that satisfies `RelayTransport<RunPaths>`, and the worker→run map.
 * SRD-REVIEW-CONSOLE §6.5, §6.6, §6.7, D4, D6, D13.
 *
 * **Named `collator-relay-adapter` and NOT `relay-adapter`, for the reason
 * `collator-relay.test.ts` spells out in its own header.** `relay.test.ts`,
 * `relay-hosted-resolution`, `relay-mount-preflight` and
 * `relay-provider-bridges` all belong to `src/security/relay.ts` — the EGRESS
 * relay, a docker network proxy with nothing whatever to do with this. Two
 * subsystems in this repo are legitimately called "relay". The prefix is the
 * disambiguation, and a case for the egress relay must never be added here.
 *
 * `collator-relay.test.ts` covers the PURE core: given four injected effects,
 * does the fan-out fan out concurrently, join, and tell the collator the truth
 * about how many lenses reported. This file covers the half that was missing —
 * the effects themselves — and every case below is written against a defect
 * that produces no visible failure.
 *
 * - **A refusal that arrives as a RESOLVED promise reads as success.**
 *   The dispatch path has two failure shapes and only one of them throws: an
 *   unreachable worker or a dead terminal raises, but a supervisor that
 *   REFUSES answers `{accepted: false, reason: ...}` on a promise that
 *   fulfils. An adapter that awaits and returns is correct against the first
 *   and silently wrong against the second. The core would then join, wait and
 *   harvest a task no worker was ever told about; every lens would report
 *   `unknown` and the console would blame the reviewers.
 *
 * - **`pane_mode_tui_has_no_rpc_dispatch` is the NORMAL path, not a failure,
 *   and reading it as one is the defect this file was rewritten to prevent.**
 *   An attended worker has no RPC dispatch surface by design; its envelope is
 *   STAGED and `via: "staged"` is a success. D13 makes all four console panes
 *   `tui`, so an adapter that spoke `cmd: "dispatch"` itself would be refused
 *   for every seat, journal three children it never dispatched, and be
 *   indistinguishable from a working console on every observable. The fixtures
 *   below therefore default every pane to `tui`, because a stand-in that
 *   answers RPC for everybody makes both routes return the same shape.
 *
 * - **An unbounded `awaitSettled` is a wedge, not a slow test.** §6.7 arms
 *   `deadline_s` at the TRIGGER, and a `tui` worker's trigger is a keystroke
 *   from a person this process cannot see. So the supervisor's own deadline may
 *   never arm, no task record may ever appear, and a poll with no host-side
 *   bound never returns. The bound is asserted here against an INJECTED clock,
 *   because a test that measured the real one would take half an hour to
 *   observe the very thing it is pinning.
 *
 * - **Folding a supervisor verdict into the lattice reads as conservative.**
 *   `timed_out` and `aborted` describe the worker, not the task, and
 *   `contracts.ts`'s lattice does not contain them. Mapping them to `failed` on
 *   the way through the adapter makes the record say a reviewer produced a
 *   failing review when what happened is that it never reported. The core's
 *   `RelayChild` carries them verbatim and reddens if they are folded; this
 *   file pins the same property one layer lower, where the fold would actually
 *   be written.
 *
 * - **`run_unresolved` must be a VALUE.** D4 makes this console four runs, so a
 *   console that is still coming up genuinely has workers with no run yet. The
 *   core answers that with a refusal the poll retries next tick; an adapter that
 *   threw instead would abort the pass and take the other requests with it.
 */
import { describe, expect, test } from "bun:test";

import type { Verdict } from "../../src/contracts.ts";
import type { RunPaths } from "../../src/run/paths.ts";
import {
  RELAY_SETTLE_DEADLINE_MS,
  RELAY_SETTLE_POLL_MS,
  RelayDispatchError,
  RelaySettleTimeoutError,
  REVIEW_CONSOLE_ASPECTS,
  consoleFanOut,
  consoleTransport,
  makeConsoleFanOut,
  resolveConsoleRuns,
  type RelayEffects,
} from "../../src/run/relay.ts";
import {
  DISPATCH_REQUEST_SCHEMA,
  type DispatchRequest,
} from "../../src/run/dispatch-request.ts";

// ---------------------------------------------------------------------------
// Fixtures. No filesystem, no sockets, no daemon — every effect is a closure.
// ---------------------------------------------------------------------------

/**
 * A `RunPaths` reduced to the two fields the adapter actually routes on.
 *
 * The cast is the point rather than a shortcut: relay's core holds the run as
 * an opaque type parameter and never reads it, so a fixture that had to build a
 * real run tree would be testing `paths.ts`. If a later edit reaches into the
 * run for a socket or a task record, these fixtures stop compiling — which is
 * the compile error the type parameter exists to produce.
 */
function fakeRun(runId: string): RunPaths {
  return { runId, root: `/runs/${runId}` } as RunPaths;
}

const COL_RUN = fakeRun("run-col");
const ARCH_RUN = fakeRun("run-arch");
const CTX_RUN = fakeRun("run-ctx");
const LANG_RUN = fakeRun("run-lang");

/** Every seat named, so nothing below is silently a "seat not requested" path. */
function request(parent = "T1"): DispatchRequest {
  return {
    schema: DISPATCH_REQUEST_SCHEMA,
    parent_task_id: parent,
    requests: REVIEW_CONSOLE_ASPECTS.map((s) => ({
      worker: s.worker,
      title: `review ${s.aspect}`,
      brief: `look at ${s.aspect}`,
    })),
  } as DispatchRequest;
}

interface Recorder {
  readonly sent: Array<{ run: string; worker: string; taskId: string; title: string; brief: string }>;
  readonly replies: Array<{ run: string; collator: string; child: string; reply: unknown }>;
  readonly harvested: string[];
  readonly slept: number[];
}

/**
 * The four panes as they actually SHIP — every one of them `tui` (D13, §0.7).
 *
 * This is the fixture the first version of this file did not have, and its
 * absence is what let a dispatch effect that only ever spoke `cmd: "dispatch"`
 * look correct: a stand-in that answers RPC for everybody makes the staged and
 * the RPC route return the SAME shape — `accepted: true` — so nothing could
 * tell them apart. `via` is the field that can, and every assertion about a
 * landed dispatch below names it.
 */
const ALL_PANES_TUI = new Set(["col-1", "rev-arch-1", "rev-ctx-1", "rev-lang-1"]);

/**
 * Effects that succeed at everything, plus a recorder.
 *
 * `overrides` is spread LAST so a case replaces exactly the one effect it is
 * about. A fixture that made each case build all eight would drift, and a drift
 * in the shared half is how a battery starts passing for the wrong reason.
 */
function effects(
  overrides: Partial<RelayEffects> = {},
): { fx: RelayEffects; rec: Recorder } {
  const rec: Recorder = {
    sent: [],
    replies: [],
    harvested: [],
    slept: [],
  };
  let clock = 0;
  const fx: RelayEffects = {
    /**
     * The DEFAULT models the shipped console: every pane is `tui`, so every
     * landed dispatch comes back `via: "staged"`. A fixture that answered
     * `via: "rpc"` here would be a console nobody is going to run.
     */
    async sendTask(run, worker, d) {
      rec.sent.push({
        run: run.runId,
        worker,
        taskId: d.taskId,
        title: d.title,
        brief: d.brief,
      });
      return {
        accepted: true,
        via: ALL_PANES_TUI.has(worker) ? "staged" : "rpc",
        reason: null,
        error: null,
        epoch: 7,
      };
    },
    async readTaskRecord() {
      return { verdict: "success" as Verdict };
    },
    async harvestTask(_run, taskId) {
      rec.harvested.push(taskId);
      return { harvest: { verdict: "success" as Verdict, task_id: taskId } };
    },
    async writeReply(run, collator, child, reply) {
      rec.replies.push({ run: run.runId, collator, child, reply });
    },
    now: () => clock,
    async sleep(ms) {
      rec.slept.push(ms);
      clock += ms;
    },
    ...overrides,
  };
  return { fx, rec };
}

const CONSOLE_RUNS = new Map<string, RunPaths>([
  ["col-1", COL_RUN],
  ["rev-arch-1", ARCH_RUN],
  ["rev-ctx-1", CTX_RUN],
  ["rev-lang-1", LANG_RUN],
]);

// ---------------------------------------------------------------------------
// 1. The name `src/cli/commands/relay.ts` looks the adapter up by.
// ---------------------------------------------------------------------------

describe("the export the poll loop resolves", () => {
  /**
   * `loadFanOut` does `mod["consoleFanOut"]` and refuses with `EXIT.INTERNAL`
   * when it is not a function. That string is spelled in two files that cannot
   * see each other, so the agreement is pinned rather than assumed — a rename on
   * either side is a red test here instead of a console that comes up, polls
   * forever and dispatches nothing.
   */
  test("`consoleFanOut` is exported from src/run/relay.ts and is callable", () => {
    expect(typeof consoleFanOut).toBe("function");
  });

  test("the CLI still looks it up under exactly that name", async () => {
    const source = await Bun.file("src/cli/commands/relay.ts").text();
    expect(source).toContain('const FAN_OUT_EXPORT = "consoleFanOut"');
  });
});

// ---------------------------------------------------------------------------
// 2. `dispatch` — the ROUTE, and the two failure shapes.
// ---------------------------------------------------------------------------

describe("dispatch, over THE dispatch path", () => {
  const seat = { worker: "rev-arch-1", taskId: "T1-arch", title: "t", brief: "b" };

  /**
   * **THE PROPERTY THE FIRST VERSION OF THIS ADAPTER GOT WRONG, AND THE ONE
   * THIS BLOCK EXISTS FOR.**
   *
   * `pane_mode_tui_has_no_rpc_dispatch` is not a failure. It is the supervisor
   * correctly answering a question nobody should have asked it: an attended
   * worker has no RPC dispatch surface BY DESIGN, and `cmd: "dispatch"` is the
   * wrong verb for one. The right verb is `cmd: "stage"` — the envelope is
   * written durably into the worker's read-only policy plane and a short
   * trigger is typed at the surface — and `sendTaskEnvelope` chooses between
   * the two by reading the launch record through `planDispatch`.
   *
   * D13 makes all four review-console panes `tui`. So an adapter that spoke
   * `cmd: "dispatch"` itself would be refused for EVERY seat on the console,
   * every lens would report `unknown`, and the fan-out would journal three
   * children it never dispatched — §6.4's own failure shape, in which "a
   * collator that dispatched three reviews is indistinguishable from one that
   * dispatched none".
   *
   * The adapter therefore owns NO routing. It delegates to the one function
   * that does, and accepts whatever plane that function reports.
   */
  test("a `tui` seat lands via `staged`, and that is a SUCCESS", async () => {
    const { fx, rec } = effects();
    // rev-arch-1 is tui in the shipped console, so the fixture stages it.
    await consoleTransport("col-1", fx).dispatch(ARCH_RUN, seat);
    expect(rec.sent).toEqual([
      { run: "run-arch", worker: "rev-arch-1", taskId: "T1-arch", title: "t", brief: "b" },
    ]);
  });

  /**
   * The same call, the same assertion, a different plane. `via` is the ONLY
   * thing that differs between these two cases — which is exactly why a fixture
   * that answered one shape for everybody could not see the defect.
   */
  test("an `rpc` seat lands via `rpc`, and that is the same success", async () => {
    const { fx } = effects({
      async sendTask() {
        return { accepted: true, via: "rpc", reason: null, error: null, epoch: 3 };
      },
    });
    await consoleTransport("col-1", fx).dispatch(ARCH_RUN, seat);
  });

  test("`pane` lands too — no plane is privileged", async () => {
    const { fx } = effects({
      async sendTask() {
        return { accepted: true, via: "pane", reason: null, error: null, epoch: 4 };
      },
    });
    await consoleTransport("col-1", fx).dispatch(ARCH_RUN, seat);
  });

  /**
   * STRUCTURAL, and deliberately so.
   *
   * The routing lives inside `sendTaskEnvelope` and is covered by that
   * function's own suite; what this file has to pin is that the adapter GOES
   * THROUGH it rather than around it. Behaviour cannot show that — a hand-rolled
   * `cmd: "dispatch"` and a delegated call are indistinguishable at the
   * `sendTask` seam, because the seam is below the routing. So the assertion is
   * on the source, and it is the assertion that would have caught the original
   * defect.
   */
  test("the adapter delegates routing and never speaks a dispatch verb itself", async () => {
    const source = await Bun.file("src/run/relay.ts").text();
    expect(source).toContain("sendTaskEnvelope");

    /**
     * COMMENTS STRIPPED FIRST, and the reason is a defect this assertion
     * already had: the docblock explaining why `cmd: "dispatch"` was WRONG
     * contains the string `cmd: "dispatch"`, so the naive check failed on the
     * very prose that records the fix. A structural assertion that cannot tell
     * code from the comment describing it is an assertion that punishes
     * documentation.
     */
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/\/\/.*$/gm, "");
    // The two verbs `sendTaskEnvelope` owns. Either one appearing in CODE here
    // means a second dispatch path has grown in a module that must not have one.
    expect(code).not.toContain('cmd: "dispatch"');
    expect(code).not.toContain('cmd: "stage"');
    // And the seam itself: `controlCall` is the RPC half of a decision this
    // module must not make.
    expect(code).not.toContain("controlCall");
  });

  test("REJECTS when the dispatch path throws (unreachable worker, dead terminal)", async () => {
    const { fx } = effects({
      async sendTask() {
        throw new Error("connect ENOENT /runs/run-arch/workers/rev-arch-1/control.sock");
      },
    });
    const p = consoleTransport("col-1", fx).dispatch(ARCH_RUN, seat);
    await expect(p).rejects.toBeInstanceOf(RelayDispatchError);
  });

  /**
   * THE SHAPE THAT READS AS SUCCESS: a resolved outcome carrying a refusal.
   * `sendTaskEnvelope` returns `{accepted: false, reason}` rather than throwing
   * for a supervisor-side rejection, so an adapter that awaited and returned
   * would treat a refusal as a delivered prompt.
   */
  test("REJECTS on a RESOLVED refusal, and names the reason", async () => {
    const { fx } = effects({
      async sendTask() {
        return {
          accepted: false,
          via: "rpc",
          reason: "already_completed",
          error: "task T1-arch has already settled",
          epoch: null,
        };
      },
    });
    const p = consoleTransport("col-1", fx).dispatch(ARCH_RUN, seat);
    await expect(p).rejects.toBeInstanceOf(RelayDispatchError);
    await p.catch((err: unknown) => {
      expect(String(err)).toContain("already_completed");
      expect((err as RelayDispatchError).refusal).toBe("already_completed");
    });
  });

  /**
   * A refusal on the STAGED plane rejects identically. Asserted separately
   * because "accepted is false" and "via is staged" is the combination a reader
   * is most likely to mistake for a success — staging is the normal path, so a
   * staged row looks right at a glance.
   */
  test("a refusal is a refusal even when it came back `staged`", async () => {
    const { fx } = effects({
      async sendTask() {
        return {
          accepted: false,
          via: "staged",
          reason: "stale_epoch",
          error: null,
          epoch: null,
        };
      },
    });
    const p = consoleTransport("col-1", fx).dispatch(ARCH_RUN, seat);
    await expect(p).rejects.toBeInstanceOf(RelayDispatchError);
  });
});
// ---------------------------------------------------------------------------
// 3. `awaitSettled` — the poll that had no helper to import, and its bound.
// ---------------------------------------------------------------------------

describe("awaitSettled, the bounded poll", () => {
  const ref = { worker: "rev-arch-1", taskId: "T1-arch" };

  test("resolves once a task record appears, and stops polling then", async () => {
    let ticks = 0;
    const { fx, rec } = effects({
      async readTaskRecord() {
        ticks += 1;
        return ticks < 3 ? null : { verdict: "success" as Verdict };
      },
    });
    await consoleTransport("col-1", fx).awaitSettled(ARCH_RUN, ref);
    expect(ticks).toBe(3);
    // Two sleeps for two absent reads; none after the record is found.
    expect(rec.slept).toEqual([RELAY_SETTLE_POLL_MS, RELAY_SETTLE_POLL_MS]);
  });

  test("polls at wait.ts's interval, not a wall clock of its own", () => {
    expect(RELAY_SETTLE_POLL_MS).toBe(100);
  });

  /**
   * §6.7: `deadline_s` defaults to 1800 and is armed at the TRIGGER. For a
   * `tui` worker the trigger is a keystroke, so the supervisor's deadline may
   * never arm at all. The host-side bound is armed at the CALL, which is the
   * only moment this process can observe.
   */
  test("the bound is deadline_s's default, in milliseconds", () => {
    expect(RELAY_SETTLE_DEADLINE_MS).toBe(1800 * 1000);
  });

  test("REJECTS when the record never appears, without a real clock", async () => {
    const { fx, rec } = effects({
      async readTaskRecord() {
        return null;
      },
    });
    const p = consoleTransport("col-1", fx).awaitSettled(ARCH_RUN, ref);
    await expect(p).rejects.toBeInstanceOf(RelaySettleTimeoutError);
    // It gave up rather than spinning: bounded above by the deadline over the
    // poll interval. A busy loop would record vastly more, and a wall-clock
    // implementation would record none at all.
    expect(rec.slept.length).toBeLessThanOrEqual(RELAY_SETTLE_DEADLINE_MS / RELAY_SETTLE_POLL_MS + 1);
    expect(rec.slept.length).toBeGreaterThan(0);
  });

  test("an explicit deadline overrides the default, and is honoured exactly", async () => {
    const { fx, rec } = effects({
      async readTaskRecord() {
        return null;
      },
    });
    const p = consoleTransport("col-1", fx, { deadlineMs: 500 }).awaitSettled(ARCH_RUN, ref);
    await expect(p).rejects.toBeInstanceOf(RelaySettleTimeoutError);
    expect(rec.slept).toEqual([100, 100, 100, 100, 100]);
  });
});

// ---------------------------------------------------------------------------
// 4. `harvest` — the verdict, verbatim.
// ---------------------------------------------------------------------------

describe("harvest", () => {
  const ref = { worker: "rev-arch-1", taskId: "T1-arch" };

  /**
   * `timed_out` and `aborted` are SUPERVISOR verdicts. They are not lattice
   * members, `rank()` answers -1 for them, and the core partitions on `success`
   * alone precisely so they can be carried through. Folding either to `failed`
   * here is the tempting bug: it reads as conservative and it records that a
   * reviewer produced a failing review, when what happened is that it never
   * reported at all.
   */
  for (const verdict of ["success", "partial", "blocked", "failed", "timed_out", "aborted", "unknown"] as const) {
    test(`carries \`${verdict}\` through unchanged`, async () => {
      const { fx } = effects({
        async harvestTask() {
          return { harvest: { verdict: verdict as Verdict } };
        },
      });
      const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);
      expect(got.verdict).toBe(verdict);
    });
  }

  test("the reply is the whole harvest bundle, not just its verdict", async () => {
    const bundle = { harvest: { verdict: "success" as Verdict }, facts: { n: 1 }, harvestStatus: "ok" };
    const { fx } = effects({
      async harvestTask() {
        return bundle;
      },
    });
    const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);
    expect(got.reply).toEqual(bundle);
  });
});

// ---------------------------------------------------------------------------
// 5. `publishReply` — into the COLLATOR's replies dir, via writeReply.
// ---------------------------------------------------------------------------

describe("publishReply", () => {
  /**
   * `writeReply` already performs the chmod-0644 → truncate-in-place →
   * chmod-0444 recipe, and it must not be reimplemented: a bind mount pins the
   * inode, so an implementation that wrote a temp file and renamed would
   * deliver a reply the collator's mount can never see. This asserts the
   * routing — the right directory owner and the right child id — and leaves the
   * recipe to `replies.ts`, which owns it.
   */
  test("routes to the collator's own replies dir under the collator's run", async () => {
    const { fx, rec } = effects();
    await consoleTransport("col-1", fx).publishReply(COL_RUN, "T1-arch", { v: 1 });
    expect(rec.replies).toEqual([
      { run: "run-col", collator: "col-1", child: "T1-arch", reply: { v: 1 } },
    ]);
  });
});

// ---------------------------------------------------------------------------
// 6. The worker→run map. D4: this console is FOUR runs.
// ---------------------------------------------------------------------------

describe("resolveConsoleRuns", () => {
  const listRuns = async () => [LANG_RUN, CTX_RUN, ARCH_RUN];

  test("the collator's own run is used for the collator, never searched for", async () => {
    let searched = 0;
    const runs = await resolveConsoleRuns({
      collator: "col-1",
      collatorRun: COL_RUN,
      workers: ["col-1"],
      listRuns: async () => {
        searched += 1;
        return [];
      },
      hasWorker: async () => false,
    });
    expect(runs.get("col-1")).toBe(COL_RUN);
    expect(searched).toBe(0);
  });

  test("a reviewer sharing the collator's run resolves without a scan", async () => {
    let scanned = 0;
    const runs = await resolveConsoleRuns({
      collator: "col-1",
      collatorRun: COL_RUN,
      workers: ["rev-arch-1"],
      listRuns: async () => {
        scanned += 1;
        return [];
      },
      hasWorker: async (run, w) => run.runId === "run-col" && w === "rev-arch-1",
    });
    expect(runs.get("rev-arch-1")).toBe(COL_RUN);
    expect(scanned).toBe(0);
  });

  test("each reviewer resolves to the run that actually holds it (D4)", async () => {
    const runs = await resolveConsoleRuns({
      collator: "col-1",
      collatorRun: COL_RUN,
      workers: ["rev-arch-1", "rev-ctx-1", "rev-lang-1"],
      listRuns,
      hasWorker: async (run, w) =>
        (run.runId === "run-arch" && w === "rev-arch-1") ||
        (run.runId === "run-ctx" && w === "rev-ctx-1") ||
        (run.runId === "run-lang" && w === "rev-lang-1"),
    });
    expect(runs.get("rev-arch-1")).toBe(ARCH_RUN);
    expect(runs.get("rev-ctx-1")).toBe(CTX_RUN);
    expect(runs.get("rev-lang-1")).toBe(LANG_RUN);
  });

  /**
   * THE ASYMMETRIC FIXTURE, and it is here because the battery caught its
   * absence.
   *
   * The case above has each worker in exactly one run, so "first match wins"
   * and "last match wins" are the SAME answer and the search order is not
   * measured at all — removing the `break` from the scan left every assertion
   * green. A console restarted after a crash is precisely the case where an
   * OLDER run still holds a directory for the same worker id, and resolving to
   * the corpse dispatches three reviews at a supervisor that is not running.
   *
   * So both candidates hold `rev-arch-1` and the newest must win.
   */
  test("when two runs hold the same worker, the NEWEST wins", async () => {
    const newest = fakeRun("run-new");
    const corpse = fakeRun("run-old");
    const runs = await resolveConsoleRuns({
      collator: "col-1",
      collatorRun: COL_RUN,
      workers: ["rev-arch-1"],
      // Newest first, which is the order the production wiring builds.
      listRuns: async () => [newest, corpse],
      // Not in the collator's run — otherwise the collator-first branch answers
      // before the scan is reached and this measures the wrong thing.
      hasWorker: async (run, w) => run.runId !== "run-col" && w === "rev-arch-1",
    });
    expect(runs.get("rev-arch-1")).toBe(newest);
    expect(runs.get("rev-arch-1")).not.toBe(corpse);
  });

  /**
   * ABSENT, not thrown and not guessed. The core answers a missing entry with
   * `run_unresolved`, which the poll retries — and a console still coming up is
   * exactly the state that produces it. An adapter that fell back to the
   * collator's run would dispatch a reviewer's task into the collator's own
   * supervisor, which accepts it.
   */
  test("a worker no run holds is simply absent from the map", async () => {
    const runs = await resolveConsoleRuns({
      collator: "col-1",
      collatorRun: COL_RUN,
      workers: ["rev-arch-1"],
      listRuns,
      hasWorker: async () => false,
    });
    expect(runs.has("rev-arch-1")).toBe(false);
    expect(runs.size).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 7. `consoleFanOut` — RelayOutcome → RelayFanOutResult.
// ---------------------------------------------------------------------------

describe("the fan-out adapter's result mapping", () => {
  function fanOutWith(fx: RelayEffects, runs = CONSOLE_RUNS) {
    return makeConsoleFanOut({
      resolveRuns: async () => runs,
      transport: (sender) => consoleTransport(sender, fx),
    });
  }

  test("a full fan-out reports `dispatched` and every issued child id", async () => {
    const { fx, rec } = effects();
    const got = await fanOutWith(fx)({
      run: COL_RUN,
      sender: "col-1",
      taskId: "T1",
      request: request(),
    });
    expect(got.kind).toBe("dispatched");
    if (got.kind !== "dispatched") throw new Error("unreachable");
    expect([...got.children].sort()).toEqual(["T1-arch", "T1-context", "T1-lang"]);
    // The collation is dispatched too, but it is NOT a child: the journal's
    // `children` is the list a reader reconciles against the collator's own
    // envelope, and the collation is the host's own follow-up.
    expect(got.children).not.toContain("T1-collate");
    expect(rec.replies.map((r) => r.child).sort()).toEqual(["T1-arch", "T1-context", "T1-lang"]);
  });

  /**
   * THE NULL-DROP PATH, which every other case in this file leaves unreached.
   *
   * `RelayChild.taskId` is `string | null` and `null` is a seat the request
   * never named. Every fixture above names all three seats, so the filter that
   * drops nulls is never exercised by them — the classic shape where a fallback
   * looks covered because the happy path is well-formed. A `null` reaching the
   * journal would be an id nothing can be looked up by, in the one record an
   * operator reconciles D5's chain against.
   */
  test("a request naming two seats journals two children, with no null", async () => {
    const { fx } = effects();
    const two = request();
    const got = await fanOutWith(fx)({
      run: COL_RUN,
      sender: "col-1",
      taskId: "T1",
      request: {
        ...two,
        requests: two.requests.filter((r) => r.worker !== "rev-lang-1"),
      } as DispatchRequest,
    });
    expect(got.kind).toBe("dispatched");
    if (got.kind !== "dispatched") throw new Error("unreachable");
    expect([...got.children].sort()).toEqual(["T1-arch", "T1-context"]);
    expect(got.children).not.toContain(null);
    expect(got.children.every((c) => typeof c === "string")).toBe(true);
  });

  /**
   * `run_unresolved` is the console-still-coming-up state, and it must arrive
   * as `not_dispatched` so the poll declines to journal and retries next tick.
   * Journalling it would mark a fan-out complete that never happened, and under
   * D5 nothing downstream would ever notice.
   */
  test("a missing run answers `not_dispatched`, never a throw", async () => {
    const { fx, rec } = effects();
    const partial = new Map(CONSOLE_RUNS);
    partial.delete("rev-ctx-1");
    const got = await fanOutWith(fx, partial)({
      run: COL_RUN,
      sender: "col-1",
      taskId: "T1",
      request: request(),
    });
    expect(got.kind).toBe("not_dispatched");
    if (got.kind !== "not_dispatched") throw new Error("unreachable");
    expect(got.reason).toContain("rev-ctx-1");
    // Nothing was issued: a partial pass would leave reviews nobody joins.
    expect(rec.sent).toHaveLength(0);
  });

  test("an unspellable parent answers `not_dispatched`, never a throw", async () => {
    const { fx } = effects();
    const got = await fanOutWith(fx)({
      run: COL_RUN,
      sender: "col-1",
      taskId: "../escape",
      request: request("../escape"),
    });
    expect(got.kind).toBe("not_dispatched");
  });

  /**
   * §6.6's zero-survivor case. No collation is dispatched — but three children
   * WERE, so the journal must record them or the next tick reissues three
   * reviews for a request that already consumed them.
   */
  test("zero survivors still reports `dispatched` with the three children", async () => {
    const { fx, rec } = effects({
      async harvestTask() {
        return { harvest: { verdict: "timed_out" as Verdict } };
      },
    });
    const got = await fanOutWith(fx)({
      run: COL_RUN,
      sender: "col-1",
      taskId: "T1",
      request: request(),
    });
    expect(got.kind).toBe("dispatched");
    if (got.kind !== "dispatched") throw new Error("unreachable");
    expect([...got.children].sort()).toEqual(["T1-arch", "T1-context", "T1-lang"]);
    // No collation, and no replies: three 0444 files no brief names are three
    // files nothing reads and nothing reaps.
    expect(rec.replies).toHaveLength(0);
    expect(rec.sent.map((s) => s.taskId).sort()).toEqual(["T1-arch", "T1-context", "T1-lang"]);
  });

  /**
   * **THE WHOLE CONSOLE AS IT SHIPS: four `tui` panes, nothing on RPC.**
   *
   * This is the case the first version of this adapter failed completely and
   * silently. Every seat stages, every stage is a success, the join runs, the
   * replies are published and the collation goes out — to a `tui` collator,
   * which stages like everyone else. If the adapter ever reintroduces an RPC
   * assumption, this is the test that reddens, and it reddens for all four
   * seats at once rather than for the last hop alone.
   */
  test("an ALL-TUI console fans out, collates, and reports every child", async () => {
    const { fx, rec } = effects();
    const got = await fanOutWith(fx)({
      run: COL_RUN,
      sender: "col-1",
      taskId: "T1",
      request: request(),
    });
    expect(got.kind).toBe("dispatched");
    if (got.kind !== "dispatched") throw new Error("unreachable");
    expect([...got.children].sort()).toEqual(["T1-arch", "T1-context", "T1-lang"]);
    // Four sends: three lenses and the collation. The collator is tui too.
    expect(rec.sent).toHaveLength(4);
    expect(rec.sent.map((s) => s.taskId)).toContain("T1-collate");
    expect(rec.sent.find((s) => s.taskId === "T1-collate")?.worker).toBe("col-1");
    // And the reports actually reached the collator's replies plane.
    expect(rec.replies.map((r) => r.child).sort()).toEqual([
      "T1-arch",
      "T1-context",
      "T1-lang",
    ]);
  });

  /**
   * One GENUINE refusal costs ONE lens, not the fan-out — and the collation
   * goes out claiming `partial`, naming the lens that is gone.
   *
   * `stale_epoch` rather than `pane_mode_tui_has_no_rpc_dispatch`, and the
   * substitution is the correction this file was rewritten around: the tui
   * reason is not a refusal the console can receive any more, because the
   * adapter no longer asks a tui worker for an RPC dispatch. A test that kept
   * using it would be pinning a state the system can no longer reach, which is
   * worse than not testing the case at all — it reads as coverage.
   */
  test("a single genuine refusal costs one lens and the collation says `partial`", async () => {
    // The override records for itself: the shared recorder is REPLACED by an
    // override, and a fixture that quietly kept recording would be measuring a
    // call this case never made.
    const sent: Array<{ worker: string; taskId: string; brief: string }> = [];
    const { fx } = effects({
      async sendTask(_run, worker, d) {
        sent.push({ worker, taskId: d.taskId, brief: d.brief });
        if (worker === "rev-ctx-1") {
          return { accepted: false, via: "staged", reason: "stale_epoch", error: null, epoch: null };
        }
        return { accepted: true, via: "staged", reason: null, error: null, epoch: 1 };
      },
    });
    const got = await fanOutWith(fx)({
      run: COL_RUN,
      sender: "col-1",
      taskId: "T1",
      request: request(),
    });
    expect(got.kind).toBe("dispatched");
    if (got.kind !== "dispatched") throw new Error("unreachable");
    expect([...got.children].sort()).toEqual(["T1-arch", "T1-context", "T1-lang"]);

    const collation = sent.find((c) => c.worker === "col-1");
    expect(collation).toBeDefined();
    expect(collation!.taskId).toBe("T1-collate");
    expect(collation!.brief).toContain("MISSING ASPECT: context");
    expect(collation!.brief).toContain('status: "partial"');
    // The lenses that DID report are not announced as missing — the negative is
    // the half that makes the assertion mean anything.
    expect(collation!.brief).not.toContain("MISSING ASPECT: arch");
  });
});
