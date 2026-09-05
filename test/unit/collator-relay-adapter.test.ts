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

import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { stripComments } from "../support/source-structure.ts";

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
  consoleRunResolution,
  makeConsoleFanOut,
  MAX_REPLY_ARTIFACT_BYTES,
  MAX_REPLY_INLINE_BYTES,
  harvestFailureNote,
  planInlineBudget,
  productionRelayEffects,
  RelayHarvestError,
  RelayReplyError,
  relayFanOut,
  resolveConsoleRuns,
  type InlinedArtifact,
  type RelayEffects,
  type RelayUnreadableEnvelope,
} from "../../src/run/relay.ts";
import type { UnreadableEnvelope } from "../../src/harvest/outbox.ts";
import type { TaskHarvest } from "../../src/harvest/index.ts";
import { renderOutcome } from "../../src/cli/commands/relay.ts";
import {
  DISPATCH_REQUEST_SCHEMA,
  REVIEW_CONSOLE_ROSTER,
  parseDispatchRequest,
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
/**
 * A request built THROUGH `parseDispatchRequest`, never cast into shape.
 *
 * The `as DispatchRequest` cast this replaces is the fixture the sibling file
 * argues against at length: a hand-built document does not meet the schema, so
 * it cannot rot when the schema changes. It would keep every case here green
 * through a field rename, a new required field, or a tightened grammar — while
 * the console refused every real request on disk.
 *
 * `briefs` lets a case make each lens' brief DISTINGUISHABLE, which is what the
 * order-influence test below needs and what nothing previously supplied.
 */
function request(
  opts: { parent?: string; workers?: readonly string[]; briefs?: (w: string) => string } = {},
): DispatchRequest {
  const parent = opts.parent ?? "T1";
  const workers = opts.workers ?? REVIEW_CONSOLE_ASPECTS.map((s) => s.worker);
  const doc = {
    schema: DISPATCH_REQUEST_SCHEMA,
    parent_task_id: parent,
    requests: workers.map((w) => ({
      worker: w,
      title: `review by ${w}`,
      brief: opts.briefs === undefined ? `look at ${w}` : opts.briefs(w),
    })),
  };
  // Through the REAL validator, with the same structural identity the poll
  // supplies: the sender is the outbox owner and the task id is the directory.
  const parsed = parseDispatchRequest(JSON.stringify(doc), {
    sender: "col-1",
    taskId: parent,
  });
  if (parsed.kind !== "ok") {
    throw new Error(`fixture is not a valid dispatch request: ${JSON.stringify(parsed)}`);
  }
  return parsed.request;
}

interface Recorder {
  readonly sent: Array<{
    run: string;
    worker: string;
    taskId: string;
    title: string;
    brief: string;
    /**
     * The plane the dispatch actually travelled. Captured because this file's
     * header claims `via` is what tells staged from rpc apart — and until now
     * NO assertion anywhere read it, so the claim was prose.
     */
    via: string;
  }>;
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
      const via = ALL_PANES_TUI.has(worker) ? "staged" : "rpc";
      rec.sent.push({
        run: run.runId,
        worker,
        taskId: d.taskId,
        title: d.title,
        brief: d.brief,
        via,
      });
      return {
        accepted: true,
        via,
        reason: null,
        error: null,
        epoch: 7,
      };
    },
    /**
     * The shipped console: `tui` panes with ADOPTED terminals, so every
     * dispatch is staged. A fixture defaulting to "rpc" would make the typed
     * plane unreachable and the security refusal untestable.
     */
    async deliveryPlane() {
      return "staged";
    },
    async readTaskRecord() {
      return { verdict: "success" as Verdict };
    },
    /** No artifacts by default: inlining is opt-in per case, so a fixture that
     * does not care about it cannot accidentally depend on it. */
    async readArtifact() {
      return { text: "", unreadable: null };
    },
    async harvestTask(_run, taskId) {
      rec.harvested.push(taskId);
      return { harvest: { verdict: "success" as Verdict, task_id: taskId } };
    },
    /**
     * The DEFAULT is `unlistable` and deliberately not `empty`.
     *
     * `empty` is a claim — *the reviewer left nothing unexpected behind* — and a
     * fixture default is the last place a claim belongs: every probe that did
     * not think about the outbox would silently assert it. `unlistable` is the
     * one arm that asserts nothing about the directory's contents, so a test
     * that means to say something about them has to say it.
     */
    async listTaskOutbox() {
      return { kind: "unlistable" as const };
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
    // The CLI now imports the binding rather than looking it up by name in a
    // dynamic module bag, so the agreement is a COMPILE error if it breaks.
    // Asserted structurally because the old dynamic guard is deleted and a
    // reader needs to see that the replacement is deliberate.
    expect(source).toContain('import { consoleFanOut } from "../../run/relay.ts"');
    expect(source).not.toContain("FAN_OUT_EXPORT");
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
      {
        run: "run-arch",
        worker: "rev-arch-1",
        taskId: "T1-arch",
        title: "t",
        brief: "b",
        // READ, not merely captured: the shipped console stages, and a fixture
        // that answered "rpc" here would be a console nobody runs.
        via: "staged",
      },
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

  /**
   * **DELETED AND REPLACED: this block used to assert that `via: "pane"` lands
   * "too — no plane is privileged".** That test pinned a security defect.
   *
   * The non-adopted `tui` pane route does not write a file; it TYPES the
   * rendered prompt into the surface line by line and presses Enter. The brief
   * is container-authored and explicitly unsanitized, and a detached or exited
   * pane hosts the operator's shell. Keeping the old assertion green would have
   * required keeping that path open.
   */
  test("the TYPED plane is refused BEFORE anything is sent", async () => {
    let sent = 0;
    const { fx } = effects({
      async deliveryPlane() {
        return "typed";
      },
      async sendTask() {
        sent += 1;
        return { accepted: true, via: "pane", reason: null, error: null, epoch: 4 };
      },
    });
    const p = consoleTransport("col-1", fx).dispatch(ARCH_RUN, seat);
    await expect(p).rejects.toBeInstanceOf(RelayDispatchError);
    // PREFLIGHT: nothing was sent. A post-check would be too late — by the time
    // `sendTask` returns `via: "pane"` the keystrokes are already typed.
    expect(sent).toBe(0);
    await p.catch((err: unknown) => {
      expect((err as RelayDispatchError).refusal).toBe("pane_delivery_types_the_brief");
    });
  });

  test("a launch record whose marks disagree is refused, not guessed", async () => {
    let sent = 0;
    const { fx } = effects({
      async deliveryPlane() {
        return "unknown";
      },
      async sendTask() {
        sent += 1;
        return { accepted: true, via: "rpc", reason: null, error: null, epoch: 4 };
      },
    });
    await expect(
      consoleTransport("col-1", fx).dispatch(ARCH_RUN, seat),
    ).rejects.toBeInstanceOf(RelayDispatchError);
    expect(sent).toBe(0);
  });

  /**
   * The backstop, for a launch record that changed between the preflight and
   * the send. Too late to prevent the typing — but a lens whose brief was typed
   * at a surface must not then be waited on and collated as a review.
   */
  test("a `pane` result is refused even when the preflight said staged", async () => {
    const { fx } = effects({
      async sendTask() {
        return { accepted: true, via: "pane", reason: null, error: null, epoch: 4 };
      },
    });
    await expect(
      consoleTransport("col-1", fx).dispatch(ARCH_RUN, seat),
    ).rejects.toBeInstanceOf(RelayDispatchError);
  });

  /**
   * ACCEPTED, durable, and still not running. `stageForAdoptedTerminal` answers
   * this whenever the adopted terminal announces no pane id — Terminal.app,
   * ssh, a bare tmux pane. Counting it as landed costs the full join deadline
   * and then the lens.
   */
  test("ACCEPTED with a deferred trigger is REJECTED, carrying the instruction", async () => {
    const { fx } = effects({
      async sendTask() {
        return {
          accepted: true,
          via: "staged",
          reason: null,
          error: "no pane id for this surface; run `pifleet trigger rev-arch-1` in the pane",
          epoch: 9,
        };
      },
    });
    const p = consoleTransport("col-1", fx).dispatch(ARCH_RUN, seat);
    await expect(p).rejects.toBeInstanceOf(RelayDispatchError);
    await p.catch((err: unknown) => {
      expect((err as RelayDispatchError).refusal).toBe("stage_trigger_deferred");
      // The instruction is the one thing that rescues the operator.
      expect(String(err)).toContain("pifleet trigger rev-arch-1");
    });
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

  /**
   * THE ORIGINAL THROW SURVIVES THE WRAP.
   *
   * Of the five sites that raise `RelayDispatchError`, exactly one has an
   * underlying error, and it used to keep the message and drop the object.
   * `SocketRequestError` reads the same whether the socket path was wrong, the
   * supervisor had gone, or the peer hung up mid-write — the `errno`, the
   * `syscall` and the stack are what tell those apart, and they were the part
   * being discarded. Asserted through `cause` identity rather than through a
   * message substring, because a message can be reconstructed and the object
   * cannot.
   */
  test("a thrown send keeps the original error as its cause", async () => {
    const original = Object.assign(new Error("connect ENOENT /run/sock"), {
      code: "ENOENT",
      syscall: "connect",
    });
    const { fx } = effects({
      async sendTask() {
        throw original;
      },
    });

    const p = consoleTransport("col-1", fx).dispatch(ARCH_RUN, seat);
    await expect(p).rejects.toBeInstanceOf(RelayDispatchError);
    const err = await p.catch((e: unknown) => e);
    // The same object, not a copy of its text: `errno` and stack come with it.
    expect((err as Error).cause).toBe(original);
    expect(((err as Error).cause as { code?: string }).code).toBe("ENOENT");
    // And the message still says the useful thing on its own.
    expect((err as Error).message).toContain("did not land");
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

  test("the reply carries the whole harvest bundle AND the artifact contents", async () => {
    const bundle = {
      harvest: {
        verdict: "success" as Verdict,
        artifacts: [{ path: "/runs/r/outbox/rev-arch-1/T1-arch/files/review.md", bytes: 11 }],
      },
      facts: { n: 1 },
      harvestStatus: "ok",
    };
    const { fx } = effects({
      async harvestTask() {
        return bundle;
      },
      async readArtifact() {
        return { text: "the review.", unreadable: null };
      },
    });
    const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);
    // Every field of the bundle survives — the digest, the facts, the status.
    expect(got.reply).toMatchObject(bundle);
    // And the thing a digest cannot carry.
    const reply = got.reply as { inlined_artifacts: InlinedArtifact[] };
    expect(reply.inlined_artifacts[0]?.text).toBe("the review.");
  });

  /**
   * THE SINGLE ADAPTER POINT, probed on both sides of its one branch.
   *
   * `RelayHarvestView.unreadableEnvelope` is `harvest/index.ts`'s own field by
   * its own name, and this is the only expression in `relay.ts` that reads it.
   * Everything the collation brief says about a lens whose review could not be
   * read flows through here, so a change that dropped the field would leave
   * every core probe green — they inject `RelayHarvest.envelope` directly — and
   * the live console silent again.
   *
   * ## WHAT THESE TWO CAN SEE
   *
   * That the harvester's four fields arrive intact and tagged, and that a
   * `null` becomes `undefined` rather than `absent`.
   *
   * ## WHAT THEY CANNOT SEE
   *
   * Whether the harvester's classification is RIGHT — `harvest-outbox-contract`
   * grades that. And they cannot see the real `\w` failure: the bundle here is
   * a literal, so a parser that stopped reporting invalid escapes would not
   * redden either one.
   */
  test("an unreadable envelope reaches the join with every field intact", async () => {
    const { fx } = effects({
      async harvestTask() {
        return {
          harvest: { verdict: "unknown" as Verdict },
          unreadableEnvelope: {
            path: "/runs/r/outbox/rev-lang-1/T1-lang/result.json",
            bytes: 3906,
            code: "not_json",
            detail: "Invalid escape character w in JSON at position 1487",
          },
        };
      },
    });
    const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);

    // Tagged, and otherwise VERBATIM. A paraphrase here would be a second
    // vocabulary for one fact, which is what the structural spelling refuses.
    expect(got.envelope).toEqual({
      kind: "unreadable",
      path: "/runs/r/outbox/rev-lang-1/T1-lang/result.json",
      bytes: 3906,
      code: "not_json",
      detail: "Invalid escape character w in JSON at position 1487",
    });
  });

  /**
   * THE INCONSISTENT BUNDLE, which the type permits and today's producer never
   * emits: the harvester's word says the envelope was unreadable, and the
   * structure describing it did not arrive.
   *
   * What this used to produce was `undefined`, and `undefined` on this field
   * means NOTHING LOOKED — the sentence written for a reviewer that produced
   * no report. That substitution is the whole shape of the incident this
   * console was fixed for: a document that existed, described as silence.
   *
   * The arm carries no production traffic. It exists because a transport that
   * serialises the harvester's verdict word and drops the nested structure —
   * anything crossing a wire — makes the combination reachable, and the failure
   * mode would be silent.
   */
  test("unreadable without its structure is still not silence", async () => {
    const { fx } = effects({
      async harvestTask() {
        return {
          harvest: { verdict: "unknown" as Verdict },
          unreadableEnvelope: null,
          envelopeRead: "unreadable" as const,
        };
      },
    });
    const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);

    expect(got.envelope).toEqual({ kind: "unreadable_unspecified" });
    // The two failures this must not be confused with.
    expect(got.envelope).not.toBeUndefined();
    expect(got.envelope).not.toEqual({ kind: "absent" });
  });

  /**
   * THE SEAM ITSELF, checked by the COMPILER rather than by a value.
   *
   * `relay.ts` spells `RelayUnreadableEnvelope` structurally instead of
   * importing the harvester's type — its standing rule, so that a module the CLI
   * reaches by dynamic import does not pull `src/harvest/` into its graph. The
   * cost of a structural spelling is that the two can DRIFT: rename a field in
   * `harvest/outbox.ts` and the adapter would quietly start carrying
   * `undefined`, the brief would lose the path or the size, and every test in
   * this file would stay green because they all build the bundle by hand.
   *
   * These two assignments are what stops that. They are erased at runtime and do
   * nothing at all when they hold; when they stop holding, `tsc` names the field
   * that moved. That is the entire "reconciling is a rename, not a rewrite"
   * claim, made checkable.
   *
   * The direction is deliberate: the harvester's type must satisfy the relay's,
   * not the other way round. The relay is the reader and may legitimately want
   * less — `code` is widened to `string` here so a new
   * `UnreadableEnvelopeCode` does not redden a module that only prints it.
   */
  test("the harvester's unreadable-envelope type still satisfies the relay's", () => {
    const _shape: RelayUnreadableEnvelope = null as unknown as UnreadableEnvelope;
    const _bundle: { readonly unreadableEnvelope?: RelayUnreadableEnvelope | null } =
      null as unknown as TaskHarvest;
    // The assertions above are the test. This keeps the runtime honest about
    // there being nothing to run, rather than leaving an empty test body.
    expect(typeof _shape).toBe("object");
    expect(typeof _bundle).toBe("object");
  });

  test("`null` is not evidence of an absent envelope", async () => {
    /**
     * THE ASYMMETRY. `unreadableEnvelope` surfaces ONE of the harvester's four
     * outcomes, so `null` means "absent or present" — and mapping it to
     * `{kind: "absent"}` would let the console say *"produced no report"* about
     * a reviewer that may well have produced one. That is the defect this whole
     * change exists to remove, committed one seam lower down, and it would be
     * invisible: every brief would read as more informative than before.
     */
    const { fx } = effects({
      async harvestTask() {
        return { harvest: { verdict: "failed" as Verdict }, unreadableEnvelope: null };
      },
    });
    const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);

    expect(got.envelope).toBeUndefined();
    expect(got.envelope).not.toEqual({ kind: "absent" });
  });

  /**
   * THE OTHER HALF OF THAT ASYMMETRY, and the reason `absent` exists at all.
   *
   * The test above pins that silence must not become a claim. This one pins that
   * a claim must not stay silent. Until `envelopeRead` landed only the first was
   * enforceable, and the cost was exact: `RelayEnvelopeState.absent` was written,
   * documented and probed at the note layer, and NOTHING COULD REACH IT — every
   * lens with no envelope was described by the weaker "nobody looked" sentence.
   *
   * The two tests share a fixture that differs in ONE field. That is deliberate:
   * a pair where the bundles also differed in verdict, or in `unreadableEnvelope`,
   * would pass against an implementation that keyed off either of those instead.
   */
  test("an envelope that was looked for and was not there is `absent`", async () => {
    const { fx } = effects({
      async harvestTask() {
        return {
          harvest: { verdict: "failed" as Verdict },
          unreadableEnvelope: null,
          envelopeRead: "missing" as const,
        };
      },
    });
    const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);

    expect(got.envelope).toEqual({ kind: "absent" });
  });

  test("a readable envelope on a lens that did not succeed is `present`", async () => {
    // `ok` is not a contradiction here: this state is only ever built for a lens
    // that did NOT succeed, which is exactly what `present` describes — the
    // reviewer reported and the report did not travel.
    const { fx } = effects({
      async harvestTask() {
        return {
          harvest: { verdict: "failed" as Verdict },
          unreadableEnvelope: null,
          envelopeRead: "ok" as const,
        };
      },
    });
    const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);

    expect(got.envelope).toEqual({ kind: "present" });
  });

  test("a refusal gets its OWN arm, and is never reported as nothing-looked", async () => {
    /**
     * **THIS TEST USED TO ASSERT THE DEFECT.** It required `undefined` on the
     * ground that a refusal is none of `present`, `absent` or `unreadable` —
     * correct about the taxonomy, wrong about the consequence. `undefined` on
     * this field is not a neutral "no arm fits"; it is read downstream as
     * NOTHING LOOKED, so the strongest signal the console has — a document it
     * read, parsed and rejected — printed the weakest sentence it owns. The
     * answer to a fact that fits no arm is a new arm, not a silence.
     */
    const { fx } = effects({
      async harvestTask() {
        return {
          harvest: { verdict: "failed" as Verdict },
          unreadableEnvelope: null,
          envelopeRead: "refused" as const,
          envelopeRefusal: "task_id names R-other, not the dispatched task",
        };
      },
    });
    const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);

    expect(got.envelope).toEqual({
      kind: "refused",
      reason: "task_id names R-other, not the dispatched task",
    });
    // The distinction the arm exists to make: still not the other three, and
    // emphatically not the silence that means no reader ever looked.
    expect(got.envelope).not.toBeUndefined();
    expect(got.envelope).not.toEqual({ kind: "absent" });
    expect(got.envelope).not.toEqual({ kind: "present" });
  });

  test("`null` STILL means nothing looked — the silence that survives", async () => {
    /**
     * The control for the test above. Widening `refused` into an arm must not
     * widen the genuine no-information case with it, or the fix trades one
     * conflation for another.
     */
    const { fx } = effects({
      async harvestTask() {
        return {
          harvest: { verdict: "failed" as Verdict },
          unreadableEnvelope: null,
          envelopeRead: null,
        };
      },
    });
    expect((await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref)).envelope).toBeUndefined();
  });

  test("a refusal that arrived without a reason still gets the arm", async () => {
    const { fx } = effects({
      async harvestTask() {
        return {
          harvest: { verdict: "failed" as Verdict },
          unreadableEnvelope: null,
          envelopeRead: "refused" as const,
        };
      },
    });
    const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);
    expect(got.envelope).toEqual({ kind: "refused", reason: null });
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
    const { runs } = await resolveConsoleRuns({
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
    const { runs } = await resolveConsoleRuns({
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
    const { runs } = await resolveConsoleRuns({
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
  test("when two runs hold the same worker, NEITHER wins — it is ambiguous", async () => {
    const newest = fakeRun("run-new");
    const corpse = fakeRun("run-old");
    const { runs, ambiguous } = await resolveConsoleRuns({
      collator: "col-1",
      collatorRun: COL_RUN,
      workers: ["rev-arch-1"],
      // Order is deliberately NOT a tiebreak any more — both are reported.
      listRuns: async () => [newest, corpse],
      // Not in the collator's run — otherwise the collator-first branch answers
      // before the scan is reached and this measures the wrong thing.
      hasWorker: async (run, w) => run.runId !== "run-col" && w === "rev-arch-1",
    });
    // NOT resolved to either. Worker ids are not unique across runs, and
    // picking the newest is how a review gets dispatched into another fleet's
    // worker — its secret, its grant, its model, its repo — and collated here.
    expect(runs.has("rev-arch-1")).toBe(false);
    expect(ambiguous.get("rev-arch-1")).toEqual(["run-new", "run-old"]);
    expect(newest.runId).toBe("run-new");
    expect(corpse.runId).toBe("run-old");
  });

  /**
   * ABSENT, not thrown and not guessed. The core answers a missing entry with
   * `run_unresolved`, which the poll retries — and a console still coming up is
   * exactly the state that produces it. An adapter that fell back to the
   * collator's run would dispatch a reviewer's task into the collator's own
   * supervisor, which accepts it.
   */
  test("a worker no run holds is simply absent from the map", async () => {
    const { runs } = await resolveConsoleRuns({
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
      resolveRuns: async () => ({ runs, ambiguous: new Map() }),
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

  /**
   * **The fixture changed because the old one could not happen.**
   *
   * It used to pass `parent_task_id: "../escape"`, cast into shape. Building
   * fixtures through `parseDispatchRequest` showed why that was wrong: the
   * parser REFUSES that id on its grammar, so no such request can reach the
   * fan-out through the real path, and the case was pinning a state the system
   * cannot enter — coverage in appearance only.
   *
   * A 60-character parent reaches the SAME guard legitimately. It is a legal id
   * to the parser (the bound is 64), and `T-context` derives 68, which
   * `derive()` refuses rather than truncating — because two parents differing
   * only past the cut would derive one child id and the second fan-out would
   * replay the first's task instead of running.
   */
  test("a legal parent whose derived child id overflows answers `not_dispatched`", async () => {
    const { fx, rec } = effects();
    const parent = "p".repeat(60);
    const got = await fanOutWith(fx)({
      run: COL_RUN,
      sender: "col-1",
      taskId: parent,
      request: request({ parent }),
    });
    expect(got.kind).toBe("not_dispatched");
    if (got.kind !== "not_dispatched") throw new Error("unreachable");
    expect(got.reason).toContain("64");
    // Refused before anything was issued.
    expect(rec.sent).toHaveLength(0);
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
  test("a single genuine refusal costs one lens and the brief reports 2 of 3 coverage", async () => {
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
    // ISSUED ONLY: rev-ctx-1's dispatch was refused, so its PLANNED id is not
    // journalled. `relay-journal.ts` calls this list "the ids the fan-out
    // issued", and a planned id there makes it a second copy of the request.
    expect([...got.children].sort()).toEqual(["T1-arch", "T1-lang"]);
    expect(got.children).not.toContain("T1-context");

    const collation = sent.find((c) => c.worker === "col-1");
    expect(collation).toBeDefined();
    expect(collation!.taskId).toBe("T1-collate");
    expect(collation!.brief).toContain("MISSING ASPECT: context");
    // §9 Q6: the lost lens is reported as COVERAGE, and the brief no longer
    // converts that count into the collator's status. The negative below is the
    // half that matters — a brief that still handed back `status: "partial"`
    // would also switch `censusCeiling` off, since it declines on any claim
    // that is not `success`.
    expect(collation!.brief).toContain("COVERAGE: 2 of 3 lenses reported");
    expect(collation!.brief).not.toContain('status: "partial"');
    // The lenses that DID report are not announced as missing — the negative is
    // the half that makes the assertion mean anything.
    expect(collation!.brief).not.toContain("MISSING ASPECT: arch");
  });
});

// ---------------------------------------------------------------------------
// 8. The collation that does not land — §6.6's last unhandled outcome.
// ---------------------------------------------------------------------------

/**
 * **The work happened. The record must say so.**
 *
 * By the time the collation is dispatched, three reviews have run and three
 * replies are on disk at 0444 in a directory the collator can read. If that
 * last dispatch throws and the pass throws with it, `relayPass` declines to
 * journal — and the next tick re-reads the same request, re-dispatches three
 * reviews and re-publishes three replies, forever. That is the unbounded repeat
 * the journal exists to prevent, arriving through the one dispatch the fan-out
 * did not guard.
 *
 * So the outcome is a THIRD arm rather than a throw and rather than a silent
 * success: the children are journalled because the children genuinely happened,
 * and the failed collation is named so nobody has to infer it from a gap.
 *
 * **These cases live in this file rather than in `collator-relay.test.ts`, and
 * the reason is a lane boundary rather than a judgement.** That file owns the
 * pure core and would be the natural home; this change was scoped to the
 * adapter's files plus `fanOut` itself, so the coverage is written where the
 * scope allowed. A later reader consolidating the two should move them.
 */
describe("a collation that does not land", () => {
  /** Reviewers succeed; the collator refuses. The natural shape of this failure. */
  function collatorRefuses(): { fx: RelayEffects; rec: Recorder } {
    return effects({
      async sendTask(_run, worker, d) {
        if (worker === "col-1") {
          throw new Error(`terminal for ${worker} is gone; ${d.taskId} cannot be triggered`);
        }
        return { accepted: true, via: "staged", reason: null, error: null, epoch: 1 };
      },
    });
  }

  test("the core answers `collation_failed`, never `collated`", async () => {
    const { fx } = collatorRefuses();
    const outcome = await relayFanOut<RunPaths>({
      request: request(),
      sender: "col-1",
      runs: CONSOLE_RUNS,
      transport: consoleTransport("col-1", fx),
    });
    expect(outcome.kind).toBe("collation_failed");
  });

  test("it carries the children, the missing seats and the collation it could not send", async () => {
    const { fx } = collatorRefuses();
    const outcome = await relayFanOut<RunPaths>({
      request: request(),
      sender: "col-1",
      runs: CONSOLE_RUNS,
      transport: consoleTransport("col-1", fx),
    });
    if (outcome.kind !== "collation_failed") throw new Error("unreachable");
    expect(outcome.children.map((c) => c.taskId).sort()).toEqual([
      "T1-arch",
      "T1-context",
      "T1-lang",
    ]);
    // Every lens reported, so nothing is missing — the collation failing is a
    // fact about the HOST's last hop, not about any reviewer.
    expect(outcome.missing).toEqual([]);
    expect(outcome.collation.taskId).toBe("T1-collate");
    expect(outcome.reason).toContain("T1-collate");
  });

  test("the replies stay published — they are what the collator will read on retry", async () => {
    const { fx, rec } = collatorRefuses();
    await relayFanOut<RunPaths>({
      request: request(),
      sender: "col-1",
      runs: CONSOLE_RUNS,
      transport: consoleTransport("col-1", fx),
    });
    expect(rec.replies.map((r) => r.child).sort()).toEqual([
      "T1-arch",
      "T1-context",
      "T1-lang",
    ]);
  });

  /**
   * THE JOURNALLING DECISION, which is the whole point of the arm.
   *
   * `dispatched` and not `not_dispatched`: three reviews were issued and must
   * never be issued again for this request.
   */
  test("the adapter maps it to `dispatched`, so the three reviews are journalled", async () => {
    const { fx } = collatorRefuses();
    const got = await makeConsoleFanOut({
      resolveRuns: async () => ({ runs: CONSOLE_RUNS, ambiguous: new Map() }),
      transport: (sender) => consoleTransport(sender, fx),
    })({ run: COL_RUN, sender: "col-1", taskId: "T1", request: request() });

    expect(got.kind).toBe("dispatched");
    if (got.kind !== "dispatched") throw new Error("unreachable");
    expect([...got.children].sort()).toEqual(["T1-arch", "T1-context", "T1-lang"]);
  });

  /**
   * **THE DISCRIMINATOR, AND IT IS DELIBERATELY NOT THE CHILDREN.**
   *
   * A clean pass and a failed collation both end with `kind: "dispatched"` and
   * both carry the same three child ids — so an assertion resting on either of
   * those cannot tell them apart, and a mutation collapsing the two arms would
   * survive. `reason` is the field that separates them: PRESENT and naming the
   * collation when the last hop failed, ABSENT when it did not.
   *
   * The pair is asserted together, in one test, because the negative is the half
   * that does the work. A `reason` that were always populated would satisfy the
   * first assertion and communicate nothing.
   */
  test("`reason` is present ONLY on the failure — the clean pass has none", async () => {
    const failed = await makeConsoleFanOut({
      resolveRuns: async () => ({ runs: CONSOLE_RUNS, ambiguous: new Map() }),
      transport: (sender) => consoleTransport(sender, collatorRefuses().fx),
    })({ run: COL_RUN, sender: "col-1", taskId: "T1", request: request() });

    const clean = await makeConsoleFanOut({
      resolveRuns: async () => ({ runs: CONSOLE_RUNS, ambiguous: new Map() }),
      transport: (sender) => consoleTransport(sender, effects().fx),
    })({ run: COL_RUN, sender: "col-1", taskId: "T1", request: request() });

    if (failed.kind !== "dispatched" || clean.kind !== "dispatched") {
      throw new Error("both arms must be `dispatched` — that is the premise being tested");
    }
    // Identical on children. Different on reason. That asymmetry IS the arm.
    expect([...failed.children].sort()).toEqual([...clean.children].sort());
    expect(failed.reason).toBeDefined();
    expect(failed.reason).toContain("T1-collate");
    expect(clean.reason).toBeUndefined();
  });

  /**
   * A `not_collated` fan-out — zero survivors — must NOT acquire a reason. It
   * dispatched no collation because there was nothing to collate, which is
   * §6.6 working rather than a last hop that failed, and conflating the two
   * would make the reason field mean two different things.
   */
  test("a zero-survivor pass is not a collation failure and carries no reason", async () => {
    const { fx } = effects({
      async harvestTask() {
        return { harvest: { verdict: "timed_out" as Verdict } };
      },
    });
    const got = await makeConsoleFanOut({
      resolveRuns: async () => ({ runs: CONSOLE_RUNS, ambiguous: new Map() }),
      transport: (sender) => consoleTransport(sender, fx),
    })({ run: COL_RUN, sender: "col-1", taskId: "T1", request: request() });
    if (got.kind !== "dispatched") throw new Error("unreachable");
    expect(got.reason).toBeUndefined();
  });

  /**
   * The operator has to SEE it. A reason carried in the result and dropped by
   * the renderer is a reason that surfaces nowhere, which is the outcome this
   * arm was built to avoid.
   *
   * `renderOutcome` is exported for this, on the precedent `classifyWorker`
   * sets one file over — "pure classification, exported so the unit suite can
   * pin the boundary ... without a filesystem".
   */
  test("the operator's line names the failed collation", () => {
    const line = renderOutcome({
      worker: "col-1",
      task_id: "T1",
      kind: "dispatched",
      children: ["T1-arch", "T1-context", "T1-lang"],
      reason: "the collation T1-collate did not land: terminal is gone",
    });
    expect(line).toContain("T1-collate");
    expect(line).toContain("3 children");
  });

  test("a clean dispatched line stays clean", () => {
    const line = renderOutcome({
      worker: "col-1",
      task_id: "T1",
      kind: "dispatched",
      children: ["T1-arch"],
    });
    expect(line).toContain("1 children");
    expect(line).not.toContain("did not land");
  });
});

// ---------------------------------------------------------------------------
// 9. Nothing landed — the state that must NEVER be journalled.
// ---------------------------------------------------------------------------

/**
 * **`survived.length === 0` is true of two opposite states and only one may be
 * journalled.** §6.6's `not_collated` is "every lens reported and none
 * survived": three tasks exist, and the journal must record them or the next
 * tick runs them again. `none_landed` is "nothing was ever started", and
 * journalling THAT marks a fan-out complete that never happened — `already_done`
 * on every later tick, the reviews never run, and the operator's row reads
 * `dispatched 3 children`.
 *
 * Reachable with nothing broken: a second review requested while round one is
 * mid-turn makes every `stage` hit a live fence and answer `busy`.
 */
describe("a fan-out where nothing landed", () => {
  function nothingLands(): { fx: RelayEffects; rec: Recorder } {
    return effects({
      async sendTask(_run, worker, d) {
        throw new Error(`worker ${worker} refused to stage ${d.taskId}: busy`);
      },
    });
  }

  test("the core answers `none_landed`, not `not_collated`", async () => {
    const { fx } = nothingLands();
    const outcome = await relayFanOut<RunPaths>({
      request: request(),
      sender: "col-1",
      runs: CONSOLE_RUNS,
      transport: consoleTransport("col-1", fx),
    });
    expect(outcome.kind).toBe("none_landed");
  });

  test("it is NOT journalled — the adapter answers `not_dispatched`", async () => {
    const { fx } = nothingLands();
    const got = await makeConsoleFanOut({
      resolveRuns: async () => ({ runs: CONSOLE_RUNS, ambiguous: new Map() }),
      transport: (sender) => consoleTransport(sender, fx),
    })({ run: COL_RUN, sender: "col-1", taskId: "T1", request: request() });

    expect(got.kind).toBe("not_dispatched");
    if (got.kind !== "not_dispatched") throw new Error("unreachable");
    expect(got.reason).toContain("NOT ONE landed");
  });

  /**
   * THE DISCRIMINATOR, and for the third time it is deliberately not the child
   * count. "Nothing landed" and "nothing survived" produce the same three seats
   * and the same zero survivors; only `kind` separates them, and the pair is
   * asserted together so a mutation collapsing them cannot pass by satisfying
   * the half that is easy.
   */
  test("`nothing landed` and `nothing survived` are told apart", async () => {
    // Nothing survived: every dispatch LANDS, every harvest is timed_out.
    const survivedNone = effects({
      async harvestTask() {
        return { harvest: { verdict: "timed_out" as Verdict } };
      },
    }).fx;
    const landedNone = nothingLands().fx;

    const a = await makeConsoleFanOut({
      resolveRuns: async () => ({ runs: CONSOLE_RUNS, ambiguous: new Map() }),
      transport: (sender) => consoleTransport(sender, survivedNone),
    })({ run: COL_RUN, sender: "col-1", taskId: "T1", request: request() });

    const b = await makeConsoleFanOut({
      resolveRuns: async () => ({ runs: CONSOLE_RUNS, ambiguous: new Map() }),
      transport: (sender) => consoleTransport(sender, landedNone),
    })({ run: COL_RUN, sender: "col-1", taskId: "T1", request: request() });

    // Work happened -> journalled, with the three ids.
    expect(a.kind).toBe("dispatched");
    if (a.kind !== "dispatched") throw new Error("unreachable");
    expect([...a.children].sort()).toEqual(["T1-arch", "T1-context", "T1-lang"]);

    // Nothing happened -> NOT journalled.
    expect(b.kind).toBe("not_dispatched");
  });

  test("a request naming no seat this console holds is a no-op, and IS journalled", async () => {
    const { fx } = effects();
    const empty = { ...request(), requests: [] } as DispatchRequest;
    const got = await makeConsoleFanOut({
      resolveRuns: async () => ({ runs: CONSOLE_RUNS, ambiguous: new Map() }),
      transport: (sender) => consoleTransport(sender, fx),
    })({ run: COL_RUN, sender: "col-1", taskId: "T1", request: empty });
    // Nothing was ATTEMPTED, so nothing failed. Journalled so it is not
    // re-evaluated on every tick forever.
    expect(got.kind).toBe("dispatched");
    if (got.kind !== "dispatched") throw new Error("unreachable");
    expect(got.children).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 10. An ambiguous console is refused, not guessed.
// ---------------------------------------------------------------------------

describe("worker→run ambiguity", () => {
  test("ANY ambiguous seat stops the whole fan-out before a dispatch", async () => {
    const { fx, rec } = effects();
    const got = await makeConsoleFanOut({
      resolveRuns: async () => ({
        runs: CONSOLE_RUNS,
        ambiguous: new Map([["rev-arch-1", ["run-a", "run-b"]]]),
      }),
      transport: (sender) => consoleTransport(sender, fx),
    })({ run: COL_RUN, sender: "col-1", taskId: "T1", request: request() });

    expect(got.kind).toBe("not_dispatched");
    if (got.kind !== "not_dispatched") throw new Error("unreachable");
    expect(got.reason).toContain("run-a");
    expect(got.reason).toContain("run-b");
    // Fail CLOSED: the unambiguous seats are not dispatched either. A review
    // whose lenses came from two fleets would report as corroboration.
    expect(rec.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 11. The roster and the aspect table are two spellings of one list.
// ---------------------------------------------------------------------------

/**
 * Not live today, and cheap to keep that way.
 *
 * `REVIEW_CONSOLE_ROSTER.reviewers` decides whose requests are ACCEPTED;
 * `REVIEW_CONSOLE_ASPECTS` decides which seats are WALKED. They are independent
 * spellings of the same three ids. A roster that gained a fourth reviewer with
 * no seat would accept requests naming it and then drop that lens from BOTH
 * `children` and `missing` — a lens that is neither reported nor reported
 * missing, which is the one outcome §6.6's brief cannot describe.
 */
describe("the roster and the aspect table agree", () => {
  test("every reviewer holds exactly one aspect, and every aspect one reviewer", () => {
    const seated = REVIEW_CONSOLE_ASPECTS.map((s) => s.worker).sort();
    expect([...REVIEW_CONSOLE_ROSTER.reviewers].sort()).toEqual(seated);
  });

  test("no collator holds a seat", () => {
    for (const c of REVIEW_CONSOLE_ROSTER.collators) {
      expect(REVIEW_CONSOLE_ASPECTS.some((s) => s.worker === c)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// 12. The collator cannot choose which BRIEF reaches which LENS.
// ---------------------------------------------------------------------------

/**
 * **D11's claim, finally tested on the axis that matters.**
 *
 * `relay.ts` walks the aspect TABLE and consults the request only to ask
 * whether a seat was named — `request.requests.find(r => r.worker === seat.worker)`.
 * Its docblock says walking `request.requests` instead "would let the collator
 * choose the order lenses are reported in, and one refactor later, which lenses
 * exist." The suite proved neither half, because every fixture made the two
 * implementations agree:
 *
 * - a request already in TABLE ORDER makes worker-matching and positional
 *   matching identical by construction;
 * - a reversed request was asserted only on derived task IDS and aspect ORDER,
 *   both of which are table-driven and therefore unchanged by a positional
 *   lookup;
 * - the one byte-identity check on a brief used a ONE-ENTRY request, where
 *   position 0 and the matching worker are the same entry.
 *
 * So this mutation survived every test in the repository:
 *
 *     for (const [i, seat] of seats.entries()) { const entry = request.requests[i];
 *
 * Under it a collator ordering its request `[lang, ctx, arch]` has the LANG
 * brief delivered to `rev-arch-1` under task id `T-arch` — the arch lens
 * reporting on a brief the collator aimed at a different reviewer, with every
 * id, every aspect name and every count still correct.
 *
 * Three properties are needed to separate the implementations and no fixture
 * had all three: a STRICT SUBSET of seats, one that EXCLUDES THE FIRST SEAT,
 * and briefs that are DISTINGUISHABLE PER WORKER. With `[lang, ctx]` requested,
 * table order walks `arch, context, lang`; positional matching would hand seat
 * `arch` the entry at index 0, which is `lang`'s.
 */
describe("brief-to-lens binding is table-driven, not positional", () => {
  /** Each brief names its intended reader, so a mis-delivery is legible. */
  const briefs = (w: string) => `read the diff as ${w}`;

  test("a subset EXCLUDING the first seat delivers each brief to its own worker", async () => {
    const { fx, rec } = effects();
    // Deliberately NOT table order, and deliberately missing `rev-arch-1` —
    // the first seat. Under positional matching, seat `arch` would take
    // requests[0], which belongs to rev-lang-1.
    const req = request({ workers: ["rev-lang-1", "rev-ctx-1"], briefs });

    await makeConsoleFanOut({
      resolveRuns: async () => ({ runs: CONSOLE_RUNS, ambiguous: new Map() }),
      transport: (sender) => consoleTransport(sender, fx),
    })({ run: COL_RUN, sender: "col-1", taskId: "T1", request: req });

    const delivered = new Map(rec.sent.map((x) => [x.worker, x.brief]));
    // THE ASSERTION THAT WAS MISSING: which brief arrived at which lens.
    expect(delivered.get("rev-lang-1")).toBe("read the diff as rev-lang-1");
    expect(delivered.get("rev-ctx-1")).toBe("read the diff as rev-ctx-1");
    // The unrequested seat is not dispatched at all — and crucially never
    // receives another worker's brief.
    expect(delivered.has("rev-arch-1")).toBe(false);
  });

  test("the task id and the brief agree — `T1-lang` carries the lang brief", async () => {
    const { fx, rec } = effects();
    const req = request({ workers: ["rev-lang-1", "rev-ctx-1"], briefs });

    await makeConsoleFanOut({
      resolveRuns: async () => ({ runs: CONSOLE_RUNS, ambiguous: new Map() }),
      transport: (sender) => consoleTransport(sender, fx),
    })({ run: COL_RUN, sender: "col-1", taskId: "T1", request: req });

    const byTask = new Map(rec.sent.map((x) => [x.taskId, x.brief]));
    // A positional implementation keeps the ids right and the briefs wrong,
    // which is exactly why asserting ids alone could never catch it.
    expect(byTask.get("T1-lang")).toBe("read the diff as rev-lang-1");
    expect(byTask.get("T1-context")).toBe("read the diff as rev-ctx-1");
  });

  test("reversing the request changes no brief's destination", async () => {
    const forward = effects();
    const reversed = effects();
    const seats = ["rev-arch-1", "rev-ctx-1", "rev-lang-1"];

    const run = async (fx: RelayEffects, workers: readonly string[]) =>
      makeConsoleFanOut({
        resolveRuns: async () => ({ runs: CONSOLE_RUNS, ambiguous: new Map() }),
        transport: (sender) => consoleTransport(sender, fx),
      })({
        run: COL_RUN,
        sender: "col-1",
        taskId: "T1",
        request: request({ workers, briefs }),
      });

    await run(forward.fx, seats);
    await run(reversed.fx, [...seats].reverse());

    const pairs = (r: Recorder) =>
      r.sent
        .filter((x) => x.worker !== "col-1")
        .map((x) => `${x.worker}|${x.taskId}|${x.brief}`)
        .sort();
    expect(pairs(reversed.rec)).toEqual(pairs(forward.rec));
  });
});

// ---------------------------------------------------------------------------
// 13. Where the production run map comes from — the producer half.
// ---------------------------------------------------------------------------

/**
 * `consoleRunResolution` is the closure that used to live inside
 * `consoleFanOut` and was executed by NOTHING. The only case touching
 * `consoleFanOut` asserts `typeof === "function"`, which constructs it and never
 * calls it — so the runs root, the listing, the newest-first ordering and the
 * liveness probe all looked covered by association with `resolveConsoleRuns`,
 * a different function that takes those very things as parameters.
 */
describe("consoleRunResolution — the candidate set, not just the decision", () => {
  function sources(over: Partial<import("../../src/run/relay.ts").ConsoleRunSources> = {}) {
    const base = {
      runsRoot: () => "/runs",
      // ASCENDING, as `runIdsAscending` returns them. The reversal is the
      // behaviour under test, so the fixture must supply the un-reversed order.
      listRunIds: async () => ["r-old", "r-new"],
      runPathsFor: (id: string) => fakeRun(id),
      /**
       * Live everywhere EXCEPT the collator's own run — otherwise
       * `resolveConsoleRuns` answers from `collatorRun` before the scan runs,
       * and the candidate ordering under test is never reached. The same shape
       * of mistake the newest-wins fixture had to fix earlier.
       */
      isLiveWorker: async (run: RunPaths) => run.runId !== "run-col",
      pinnedRuns: () => undefined,
    };
    return { ...base, ...over } as import("../../src/run/relay.ts").ConsoleRunSources;
  }
  const input = {
    run: COL_RUN,
    sender: "col-1",
    taskId: "T1",
    request: request(),
  };

  /**
   * NEWEST FIRST, asserted rather than asserted-in-prose.
   *
   * Ordering no longer decides RESOLUTION — ambiguity is refused, and one match
   * is one match in any order. What it decides is the order of the reported
   * ids, so the operator reading "held by X, Y" sees the run they most likely
   * just started first. Dropping the `reverse()` reddens here, which is the
   * point: a line whose only remaining job is reporting still has a job.
   */
  test("candidates are ordered newest-first", async () => {
    const { runs, ambiguous } = await consoleRunResolution(input, sources());
    expect(runs.has("rev-arch-1")).toBe(false);
    expect(ambiguous.get("rev-arch-1")).toEqual(["r-new", "r-old"]);
  });

  test("a dead run is not a candidate at all", async () => {
    const { runs } = await consoleRunResolution(
      input,
      sources({ isLiveWorker: async (run: RunPaths) => run.runId === "r-new" }),
    );
    // Exactly one LIVE holder, so it resolves rather than refusing.
    expect(runs.get("rev-arch-1")?.runId).toBe("r-new");
  });

  test("an explicit pin bypasses the scan entirely", async () => {
    let listed = 0;
    const { runs, ambiguous } = await consoleRunResolution(
      input,
      sources({
        pinnedRuns: () => "rev-arch-1=r-pin,rev-ctx-1=r-pin2",
        listRunIds: async () => {
          listed += 1;
          return [];
        },
      }),
    );
    expect(listed).toBe(0);
    expect(runs.get("rev-arch-1")?.runId).toBe("r-pin");
    expect(runs.get("rev-ctx-1")?.runId).toBe("r-pin2");
    // The collator is always its own run, never pinned from the environment.
    expect(runs.get("col-1")).toBe(COL_RUN);
    expect(ambiguous.size).toBe(0);
  });

  test("the workers asked for are the sender plus every seat", async () => {
    const asked: string[] = [];
    await consoleRunResolution(
      input,
      sources({
        isLiveWorker: async (_run: RunPaths, w: string) => {
          asked.push(w);
          return false;
        },
      }),
    );
    for (const seat of REVIEW_CONSOLE_ASPECTS) expect(asked).toContain(seat.worker);
  });
});

// ---------------------------------------------------------------------------
// 14. The operator-facing stream, and the durable record behind it.
// ---------------------------------------------------------------------------

describe("what the operator is told, and what outlives the telling", () => {
  /**
   * D2: the churn that buried the signal.
   *
   * `relayPass` reports every journalled request on every pass, so a settled
   * console printed N lines every `DEFAULT_POLL_S` seconds forever — defeating
   * this module's own rule that `missing` is not an outcome so "the one row
   * that means something" is not buried. It is also how a `collation_failed`
   * reason, printed once, scrolls out of reach in seconds.
   */
  test("`already_done` renders as a single line, not a stream", () => {
    const line = renderOutcome({
      worker: "col-1",
      task_id: "T1",
      kind: "already_done",
      children: ["T1-arch"],
    });
    expect(line).toContain("already dispatched, unchanged");
  });

  /**
   * D3: the reason has to outlive the line that printed it.
   *
   * A `dispatched` outcome carrying a reason is the one row an operator must be
   * able to find AFTER the fact — the next tick says `already_done, unchanged`
   * and three 0444 replies sit in the collator's mount with nothing telling it
   * to read them. `relayPass` appends it to the ledger; this pins that the
   * outcome still carries it out to the caller, which is what the command
   * appends FROM.
   */
  test("a dispatched outcome carrying a reason still surfaces it", () => {
    const line = renderOutcome({
      worker: "col-1",
      task_id: "T1",
      kind: "dispatched",
      children: ["T1-arch", "T1-context", "T1-lang"],
      reason: 'the collation "T1-collate" could not be delivered',
    });
    expect(line).toContain("T1-collate");
    expect(line).toContain("3 children");
  });
});

// ---------------------------------------------------------------------------
// 15. The reply carries the review, and says so when it does not.
// ---------------------------------------------------------------------------

/**
 * **A digest is what you carry when the thing itself is somewhere the reader
 * can reach.** `HarvestedArtifactSchema` is `{path, bytes, sha256}`, and the
 * reviewer's `/outbox` is worker-scoped — so a review filed at
 * `/outbox/<task>/files/review.md` was a document nothing in this console could
 * open, while every status stayed green. The contents now travel.
 */
describe("inlining artifact contents", () => {
  const ref = { worker: "rev-arch-1", taskId: "T1-arch" };

  function withArtifacts(
    sizes: readonly number[],
    read?: RelayEffects["readArtifact"],
  ): { fx: RelayEffects; paths: string[] } {
    const paths = sizes.map((_, i) => `/runs/r/outbox/rev-arch-1/T1-arch/files/a${i}.md`);
    const { fx } = effects({
      async harvestTask() {
        return {
          harvest: {
            verdict: "success" as Verdict,
            artifacts: sizes.map((bytes, i) => ({ path: paths[i]!, bytes })),
          },
        };
      },
      readArtifact:
        read ??
        (async (_run, _worker, hostPath, maxBytes) => {
          const i = paths.indexOf(hostPath);
          return { text: "x".repeat(Math.min(sizes[i] ?? 0, maxBytes)), unreadable: null };
        }),
    });
    return { fx, paths };
  }

  test("a small review arrives whole and is not marked truncated", async () => {
    const { fx } = withArtifacts([120]);
    const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);
    expect(got.inlined?.[0]?.included_bytes).toBe(120);
    expect(got.inlined?.[0]?.truncated).toBe(false);
  });

  test("an oversized artifact is cut at the per-artifact cap and MARKED", async () => {
    const { fx } = withArtifacts([MAX_REPLY_ARTIFACT_BYTES * 2]);
    const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);
    expect(got.inlined?.[0]?.included_bytes).toBe(MAX_REPLY_ARTIFACT_BYTES);
    expect(got.inlined?.[0]?.truncated).toBe(true);
  });

  test("an unreadable artifact is distinct from a truncated one", async () => {
    const { fx } = withArtifacts([500], async () => ({
      text: "",
      unreadable: "it is a symlink",
    }));
    const got = await consoleTransport("col-1", fx).harvest(ARCH_RUN, ref);
    expect(got.inlined?.[0]?.unreadable).toBe("it is a symlink");
    // NOT truncated: nothing arrived at all, which is a different fact.
    expect(got.inlined?.[0]?.truncated).toBe(false);
    expect(got.inlined?.[0]?.included_bytes).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// 16. Which review survives must not depend on enumeration order.
// ---------------------------------------------------------------------------

describe("planInlineBudget — fair, and order-independent", () => {
  const total = 1000;
  const per = 400;

  test("everything fits when the budget is not contended", () => {
    expect(planInlineBudget([100, 200], { perArtifact: per, total })).toEqual([100, 200]);
  });

  test("no artifact exceeds the per-artifact cap", () => {
    const got = planInlineBudget([9999, 9999], { perArtifact: per, total });
    expect(got).toEqual([400, 400]);
  });

  test("the total is never exceeded", () => {
    const got = planInlineBudget([500, 500, 500, 500], { perArtifact: per, total });
    expect(got.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(total);
  });

  /**
   * **THE PROPERTY THE WHOLE ALLOCATOR EXISTS FOR.**
   *
   * First-come-first-served would give the first artifact everything it asked
   * for and starve the rest — so which half of a review survived would depend on
   * the order `readdir` happened to return. Reversing the input must change
   * nothing but the order of the answers.
   */
  test("reversing the artifact order changes no artifact's allocation", () => {
    const sizes = [50, 900, 120, 700];
    const forward = planInlineBudget(sizes, { perArtifact: per, total });
    const backward = planInlineBudget([...sizes].reverse(), { perArtifact: per, total });
    expect([...backward].reverse()).toEqual(forward);
  });

  /**
   * A big artifact must not consume the budget a small one needed. Max-min
   * fairness: the small ones are satisfied in full, the large ones divide what
   * is left — which is the opposite of what a greedy walk does.
   */
  /**
   * **This fixture was rebuilt because the battery caught it.**
   *
   * It was `[10, 100_000]`, which cannot distinguish ascending from descending:
   * at two artifacts the equal share (500) exceeds the per-artifact cap (400)
   * either way, so both orders give the same answer and sorting DESCENDING
   * survived. Max-min fairness only differs from its reverse when the small
   * claims are numerous enough that satisfying them first RELEASES budget the
   * large one can then use.
   *
   * Three tiny artifacts and one large one, with a total too small to satisfy
   * everyone: ascending settles the three for 30 and hands the remaining 410 to
   * the large one, which takes its cap of 400. Descending hands the large one
   * only its equal share of 110 and then discovers the small ones needed 30
   * between them — 300 bytes of review budget wasted, and the largest document
   * is the one that loses them.
   */
  test("satisfying small artifacts first RELEASES budget to the large one", () => {
    const got = planInlineBudget([10, 10, 10, 900], { perArtifact: per, total: 440 });
    expect(got.slice(0, 3)).toEqual([10, 10, 10]);
    // 400 (its cap), not 110 (an equal quarter of 440).
    expect(got[3]).toBe(400);
  });

  test("equal sizes get equal shares, and ties are stable", () => {
    expect(planInlineBudget([600, 600, 600], { perArtifact: per, total })).toEqual([333, 333, 334]);
  });

  test("no artifacts is not a special case", () => {
    expect(planInlineBudget([], { perArtifact: per, total })).toEqual([]);
  });

  /** The shipped numbers, pinned so a change is deliberate. */
  test("the caps are the reply plane's stated numbers", () => {
    expect(MAX_REPLY_ARTIFACT_BYTES).toBe(64 * 1024);
    expect(MAX_REPLY_INLINE_BYTES).toBe(256 * 1024);
    // A quarter of the reply budget: four artifacts always fit at full size.
    expect(MAX_REPLY_ARTIFACT_BYTES * 4).toBe(MAX_REPLY_INLINE_BYTES);
  });
});

// ---------------------------------------------------------------------------
// 17. A truncation reaches the collator as a NAMED missing thing.
// ---------------------------------------------------------------------------

/**
 * **The half of Take A that makes the cap safe.**
 *
 * §6.6 names a missing lens because *"a collator that does not know it is
 * missing a lens will write a confident three-lens conclusion from two"*. A
 * truncated review is worse: there is no gap in it to notice, so it reads as a
 * complete review that found less. A cap without this is a downgrade, not a fix.
 */
describe("truncation in the collation brief", () => {
  async function briefFor(read: RelayEffects["readArtifact"], bytes: number): Promise<string> {
    const path = "/runs/r/outbox/rev-arch-1/T1-arch/files/review.md";
    const sent: Array<{ worker: string; brief: string }> = [];
    const { fx } = effects({
      async sendTask(_run, worker, d) {
        sent.push({ worker, brief: d.brief });
        return { accepted: true, via: "staged", reason: null, error: null, epoch: 1 };
      },
      async harvestTask(_run, taskId) {
        return {
          harvest: {
            verdict: "success" as Verdict,
            // Only the arch lens has an artifact, so the brief's lines are
            // attributable to one aspect rather than to "some reviewer".
            artifacts: taskId === "T1-arch" ? [{ path, bytes }] : [],
          },
        };
      },
      readArtifact: read,
    });
    await makeConsoleFanOut({
      resolveRuns: async () => ({ runs: CONSOLE_RUNS, ambiguous: new Map() }),
      transport: (sender) => consoleTransport(sender, fx),
    })({ run: COL_RUN, sender: "col-1", taskId: "T1", request: request() });
    return sent.find((x) => x.worker === "col-1")?.brief ?? "";
  }

  test("a cut artifact is named, with both byte counts", async () => {
    const brief = await briefFor(
      async (_r, _w, _p, max) => ({ text: "x".repeat(max), unreadable: null }),
      MAX_REPLY_ARTIFACT_BYTES * 3,
    );
    expect(brief).toContain("TRUNCATED: arch's artifact");
    expect(brief).toContain("review.md");
    // Both numbers, so the collator can see HOW partial the document is.
    expect(brief).toContain(String(MAX_REPLY_ARTIFACT_BYTES * 3));
    expect(brief).toContain(String(MAX_REPLY_ARTIFACT_BYTES));
    expect(brief).toContain("You are reading a PART of that document");
  });

  test("an unreadable artifact is named SEPARATELY from a truncated one", async () => {
    const brief = await briefFor(async () => ({ text: "", unreadable: "it is a symlink" }), 900);
    expect(brief).toContain("UNREADABLE: arch's artifact");
    expect(brief).toContain("it is a symlink");
    expect(brief).toContain("None of it reached you");
    // Not conflated: nothing arrived, which is not the same as arriving short.
    expect(brief).not.toContain("TRUNCATED:");
  });

  /**
   * THE NEGATIVE HALF, and it is the one that makes the positives mean
   * something. A brief that carried a truncation warning unconditionally would
   * satisfy every assertion above and tell the collator nothing.
   */
  test("a whole review produces NO truncation line at all", async () => {
    const brief = await briefFor(
      async (_r, _w, _p, max) => ({ text: "x".repeat(Math.min(50, max)), unreadable: null }),
      50,
    );
    expect(brief).not.toContain("TRUNCATED:");
    expect(brief).not.toContain("UNREADABLE:");
    expect(brief).not.toContain("You are reading a PART");
    /**
     * The GUIDANCE line too, and the battery is why.
     *
     * An unconditional section (`if (true)`) emits no per-artifact lines when
     * nothing was cut — so every assertion above passed while the brief still
     * told the collator its documents might be partial. A warning that appears
     * on every brief is one a reader learns to skip, which is exactly how the
     * named truncation stops being worth naming.
     */
    expect(brief).not.toContain("Do not present a conclusion drawn from a truncated");
    // The brief is otherwise intact.
    expect(brief).toContain("3 produced a report");
  });
});

/**
 * `readArtifact` resolves the artifact's path ONCE.
 *
 * **THE RACE THIS CLOSES CANNOT BE FORCED FROM A UNIT TEST, AND THAT IS STATED
 * RATHER THAN DISGUISED.** The defect was `lstat`-then-`open` on the same
 * name: two independent resolutions with a worker-writable directory between
 * them, so a container that swaps its own artifact for a symlink in the gap is
 * read at the target. Every STATIC input gives the old code and the new code
 * the same answer — a symlink is refused either way, once by `lstat` and once
 * by `O_NOFOLLOW` — because the fix changes only what happens when the name
 * changes mid-call, and a test cannot schedule itself into that window.
 *
 * So the behavioural cases below are REGRESSION cover: they pin that removing
 * the `lstat` did not widen any refusal. What pins the fix itself is the
 * structural assertion, on `monitor-density.test.ts`'s precedent in this repo —
 * a weaker check that fails on exactly the regression that matters, chosen
 * deliberately over a stronger one that cannot be written.
 */
/**
 * D6's ONE failure mode, recognisable as a RULE rather than as a paragraph.
 *
 * The publish path deliberately does not create a missing `/replies` source —
 * Docker would make an empty directory rather than refuse, so three reports
 * would be delivered somewhere the collator's mount can never see, and every
 * observable would say it worked. That refusal is right and it PROPAGATES.
 *
 * What it did not do was let a caller tell it apart from any other write
 * failure without matching English, which is the practice this module's own
 * `RelayDispatchError` docblock forbids in as many words. The paragraph is the
 * part most likely to be rewritten; the type and its three fields are not.
 */
/**
 * THE LISTING IS TAKEN WHERE THE HARVEST FAILED, and this is the seam that
 * makes ISC-517's second route closable at all.
 *
 * `listTaskOutbox` needs the worker's outbox directory and the task id. Neither
 * is an input the failed harvest supplied — no inbox envelope, no epoch, no
 * worktree — so it can answer at the exact moment `harvestTask` could not. The
 * core cannot take it itself: deriving a host path is the thing `relay.ts`'s
 * header keeps out of that module, which is why it rides back on the rejection.
 */
describe("a failed harvest carries a pointer to what it could not read", () => {
  const ref = { worker: "rev-lang-1", taskId: "T1-lang" };
  const LISTING = {
    kind: "unrecognised" as const,
    total: 1,
    named: [{ name: "artifact.json", kind: "file" as const, bytes: 12759 }],
  };

  test("the rejection is a RelayHarvestError carrying the listing and the cause", async () => {
    const torn = Object.assign(new Error("state.json is torn"), { code: "EBADF" });
    const asked: Array<{ worker: string; taskId: string }> = [];
    const { fx } = effects({
      async harvestTask() {
        throw torn;
      },
      async listTaskOutbox(_run, worker, taskId) {
        asked.push({ worker, taskId });
        return LISTING;
      },
    });

    const p = consoleTransport("col-1", fx).harvest(LANG_RUN, ref);
    await expect(p).rejects.toBeInstanceOf(RelayHarvestError);
    const err = (await p.catch((e: unknown) => e)) as RelayHarvestError;

    expect(err.worker).toBe("rev-lang-1");
    expect(err.taskId).toBe("T1-lang");
    expect(err.outbox).toEqual(LISTING);
    // The original throw, by identity — the errno survives the wrap.
    expect(err.cause).toBe(torn);
    // Asked about the task that failed, not some other one.
    expect(asked).toEqual([{ worker: "rev-lang-1", taskId: "T1-lang" }]);
  });

  test("a listing that throws too leaves null, which is not `unlistable`", async () => {
    const { fx } = effects({
      async harvestTask() {
        throw new Error("state.json is torn");
      },
      async listTaskOutbox() {
        throw new Error("the outbox directory is gone as well");
      },
    });

    const p = consoleTransport("col-1", fx).harvest(LANG_RUN, ref);
    const err = (await p.catch((e: unknown) => e)) as RelayHarvestError;

    // Three states, and this is the first: no listing was ATTEMPTED
    // successfully, so there is nothing to say. `unlistable` would claim a
    // readdir ran and failed; `empty` would claim the directory was read.
    expect(err.outbox).toBeNull();
    // The harvest's own reason is still the one reported — a second failure
    // must not overwrite the first.
    expect(err.message).toContain("state.json is torn");
  });

  test("a harvest that RETURNS never asks for the recovery listing", async () => {
    // The listing exists for the arm where nothing was read. Taking it on the
    // success path would be a second answer to a question the bundle already
    // answers, and the two could disagree.
    let asked = 0;
    const { fx } = effects({
      async harvestTask() {
        return { harvest: { verdict: "success" as Verdict }, taskOutbox: { kind: "empty" } };
      },
      async listTaskOutbox() {
        asked += 1;
        return LISTING;
      },
    });

    const got = await consoleTransport("col-1", fx).harvest(LANG_RUN, ref);
    expect(asked).toBe(0);
    expect(got.outbox).toEqual({ kind: "empty" });
  });
});

describe("writeReply refuses a missing replies mount, by type", () => {
  test("a missing replies directory throws RelayReplyError carrying the facts", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-replies-"));
    // No `up`, so nothing created the collator's replies directory.
    const p = productionRelayEffects.writeReply({ root } as RunPaths, "col-1", "T1-arch", {
      verdict: "success",
    });

    await expect(p).rejects.toBeInstanceOf(RelayReplyError);
    const err = (await p.catch((e: unknown) => e)) as RelayReplyError;
    // Fields, not substrings: which collator, which report, which directory.
    expect(err.collator).toBe("col-1");
    expect(err.childTaskId).toBe("T1-arch");
    expect(err.repliesDir.startsWith(root)).toBe(true);
    // The original ENOENT is kept, so the errno survives the wrap.
    expect((err.cause as NodeJS.ErrnoException | undefined)?.code).toBe("ENOENT");
    // And the sentence still tells an operator whose job the directory is.
    expect(err.message).toContain("pifleet up");
  });
});

/**
 * The production listing, over a real directory.
 *
 * The unit probes above inject it, so nothing there would notice if the effect
 * derived the wrong host path — and the path is exactly what it exists to
 * supply. This drives the real `listTaskOutbox` against a real outbox and
 * checks the two properties that make the recovery worth anything: it finds the
 * task's OWN directory, and it says `unlistable` rather than inventing `empty`
 * for one that is not there.
 */
describe("the production listTaskOutbox derives the task's own outbox", () => {
  test("it lists the unexpected entries a reviewer left in its task root", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-listing-"));
    const taskRoot = join(root, "outbox", "rev-lang-1", "T1-lang");
    await mkdir(join(taskRoot, "files"), { recursive: true });
    // The shape the live console actually hit: a complete review filed under a
    // name neither reader recognises.
    await writeFile(join(taskRoot, "artifact.json"), "x".repeat(120));
    await writeFile(join(taskRoot, "result.json"), "{}");

    const got = await productionRelayEffects.listTaskOutbox(
      { root } as RunPaths,
      "rev-lang-1",
      "T1-lang",
    );

    if (got.kind !== "unrecognised") throw new Error(`expected unrecognised, got ${got.kind}`);
    // `result.json` and `files/` are recognised and filtered out; the review
    // filed under an invented name is the entry that survives.
    expect(got.named.map((e) => e.name)).toEqual(["artifact.json"]);
    expect(got.named[0]!.bytes).toBe(120);
  });

  test("a task root that is not there is `unlistable`, never `empty`", async () => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-listing-"));
    const got = await productionRelayEffects.listTaskOutbox(
      { root } as RunPaths,
      "rev-lang-1",
      "T1-nothing",
    );
    // `empty` is a claim about what a reviewer left behind. Nothing was read.
    expect(got).toEqual({ kind: "unlistable" });
  });
});

describe("readArtifact resolves the path once", () => {
  const outboxFor = async (): Promise<{ root: string; dir: string }> => {
    const root = await mkdtemp(join(tmpdir(), "pifleet-artifact-"));
    const dir = join(root, "outbox", "rev-lang-1", "T-1", "files");
    await mkdir(dir, { recursive: true });
    return { root, dir };
  };
  const read = (root: string, p: string) =>
    productionRelayEffects.readArtifact({ root } as RunPaths, "rev-lang-1", p, 4096);

  test("a regular file in the worker's own outbox is read", async () => {
    const { root, dir } = await outboxFor();
    const p = join(dir, "review.md");
    await writeFile(p, "the review body");
    expect(await read(root, p)).toEqual({ text: "the review body", unreadable: null });
  });

  test("a symlink is refused and the target's bytes do not escape", async () => {
    const { root, dir } = await outboxFor();
    const secret = join(root, "control-auth.json");
    await writeFile(secret, '{"token":"SHOULD-NEVER-BE-INLINED"}');
    const p = join(dir, "review.md");
    // The relative climb a container writes from inside its own /outbox.
    await symlink("../../../../control-auth.json", p);

    const got = await read(root, p);
    // The message changed when containment moved onto the RESOLVED path: an
    // escaping link is now named for what makes it dangerous — where it lands —
    // rather than for its type. Either way the target's bytes never appear.
    expect(got.unreadable).toContain("resolves outside");
    expect(got.text).toBe("");
    expect(JSON.stringify(got)).not.toContain("SHOULD-NEVER-BE-INLINED");
  });

  /**
   * THE INTERMEDIATE COMPONENT, which the first version of this fix missed.
   *
   * `O_NOFOLLOW` refuses only the FINAL component, and `isPathUnder` compares
   * strings without ever asking the filesystem — so a worker that turns its own
   * `files/` directory into a symlink to the run root passed containment and
   * had the target opened. The console found this in the same commit that
   * introduced the final-component fix.
   */
  test("a symlinked INTERMEDIATE directory cannot reach the run root", async () => {
    const { root, dir } = await outboxFor();
    const secret = join(root, "control-auth.json");
    await writeFile(secret, '{"token":"SHOULD-NEVER-BE-INLINED"}');
    // Replace <task>/files with a link to the run root, then name a real file
    // through it. Every component of the string is inside the outbox.
    await rm(dir, { recursive: true, force: true });
    await symlink(root, dir);

    const got = await read(root, join(dir, "control-auth.json"));
    expect(got.text).toBe("");
    expect(got.unreadable).toContain("resolves outside");
    expect(JSON.stringify(got)).not.toContain("SHOULD-NEVER-BE-INLINED");
  });

  test("a directory is refused as not a regular file", async () => {
    const { root, dir } = await outboxFor();
    expect((await read(root, dir)).unreadable).toBe("it is not a regular file");
  });

  test("a path outside the worker's outbox is refused before anything is opened", async () => {
    const { root } = await outboxFor();
    const secret = join(root, "control-auth.json");
    await writeFile(secret, '{"token":"SHOULD-NEVER-BE-INLINED"}');
    const got = await read(root, secret);
    expect(got.unreadable).toBe("it is not inside rev-lang-1's outbox");
    expect(JSON.stringify(got)).not.toContain("SHOULD-NEVER-BE-INLINED");
  });

  test("the open carries O_NOFOLLOW and nothing stats the NAME beforehand", () => {
    const src = readFileSync("src/run/relay.ts", "utf8");
    const start = src.indexOf("async readArtifact(");
    const body = stripComments(src.slice(start, src.indexOf("async writeReply(", start)));
    expect(start).toBeGreaterThan(0);
    // The flag is what refuses a swapped name at the moment of the open.
    expect(body).toContain("O_NOFOLLOW");
    // The FIFO refusal this inherited must not be lost to the rewrite.
    expect(body).toContain("O_NONBLOCK");
    // A second resolution of the same name is the defect itself; every fact
    // after the open must come from the HANDLE.
    expect(body).not.toContain("lstat");
    expect(body).toContain("handle.stat()");
  });
});


/**
 * A harvest that THREW must say so, on the dispatch arm's precedent.
 *
 * The dispatch failure path captures its rejection into the child's note. The
 * harvest path emitted one fixed sentence and dropped the reason, so a torn
 * `state.json` was reported with strictly less information than a refused
 * dispatch. This does not change which lenses are lost — only whether the
 * operator is told why.
 */
describe("a failed harvest carries its reason", () => {
  test("a reason is named", () => {
    const note = harvestFailureNote("StateReadError: state.json is not JSON");
    expect(note).toContain("StateReadError: state.json is not JSON");
    expect(note).toContain("FAILED");
  });

  test("no reason still reads as a whole sentence, and claims nothing extra", () => {
    // `undefined` means the harvest RESOLVED and produced no entry, which is a
    // different fact from one that threw — so it must not borrow the wording.
    const note = harvestFailureNote(undefined);
    expect(note).toBe("it was dispatched but could not be harvested");
    expect(note).not.toContain("FAILED");
  });
});
