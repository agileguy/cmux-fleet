/**
 * The staged-dispatch verbs — `stage` and `unstage` (SRD-TUI-DISPATCH D6, D12,
 * §9 Q1, §9 Q8).
 *
 * ## Why this file can be behavioural where `supervisor-tui.test.ts` cannot
 *
 * That file states the constraint plainly: `src/supervisor/index.ts` is one
 * 2000-line `main()` that spawns a process and opens a socket, so the risk in
 * it can only be graded structurally — read the source and assert the wiring,
 * because a battery of probes that all call the pure helper directly stays
 * green through a refactor that stops CALLING it.
 *
 * `handleStage` and `handleUnstage` are at module scope with an explicit
 * dependency object, so they are the first pieces of the control plane that can
 * be RUN. That shape was chosen for a different reason — see `StageDeps`, and
 * the paragraph below — and testability is the dividend.
 *
 * ## The four claims, and what each is defending
 *
 * 1. **`stage` allocates a real epoch and does not send.** D6 replaces the
 *    placeholder `0` that `harvest/outbox.ts` correlates VACUOUSLY on this
 *    route with a value that is actually checked — which means it also creates
 *    the first way for this route to fail that check, so the number has to be
 *    the allocator's own and has to survive replay.
 * 2. **`unstage` releases without settling.** §9 Q8, and the whole argument for
 *    `cancel` over `settle("cancelled")` is that a cancelled task never ran, so
 *    a later different attempt must not meet `already_completed`.
 * 3. **The deadline is parked, not started.** §9 Q1: a 20-minute task staged
 *    before lunch must not be `timed_out` before it begins.
 * 4. **Defect B is closed.** §2.4's dead settle path was dead because nothing
 *    ever made `em.live` non-null for a `tui` worker. The poll's gate is
 *    literally `const live = em.live; if (live === null) return;`, so a probe
 *    that runs `handleStage` against a REAL `EpochManager` and reads `em.live`
 *    is testing that gate's exact condition without needing the poll.
 *
 * The structural half at the end covers the two things a run cannot show: that
 * `stage` has no route to a `send`, and that the RPC `dispatch` refusal it was
 * built beside is untouched.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { EpochManager } from "../../src/rpc/epoch.ts";
import { TaskEnvelopeSchema, type TaskEnvelope, type WorkerState } from "../../src/contracts.ts";
import { initialWorkerState } from "../../src/run/state.ts";
import {
  handleStage,
  handleUnstage,
  type StageDeps,
  type UnstageAnswer,
} from "../../src/supervisor/index.ts";
import { stripComments } from "../support/source-structure.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SUPERVISOR = stripComments(readFileSync(`${ROOT}src/supervisor/index.ts`, "utf8"));

/**
 * Built through the real schema, so a field rename cannot leave the fixture
 * behind — the same reason `dispatch-pane-route.test.ts` builds its launch
 * record through `WorkerLaunchSchema`.
 */
function envelope(taskId: string, overrides: Record<string, unknown> = {}): TaskEnvelope {
  return TaskEnvelopeSchema.parse({
    schema: "pifleet.task/v1",
    task_id: taskId,
    run_id: "2026-09-02T09-00-00Z-stg",
    epoch: 0,
    attempt: 1,
    worker: "tui-1",
    dispatched_at: "2026-09-02T09:00:00Z",
    title: `Do ${taskId}`,
    brief: "Full markdown instructions",
    repo: "/repo",
    host_workdir: "/repo/.worktrees/tui-1",
    container_workdir: "/workspace",
    branch: "fleet/run/tui-1",
    base_ref: "9f1c2ab3e4d5f60718293a4b5c6d7e8f90a1b2c3",
    outbox: `/outbox/${taskId}`,
    deadline_s: 1200,
    ...overrides,
  });
}

interface Harness {
  em: EpochManager;
  state: WorkerState;
  deps: StageDeps & { shuttingDown: boolean; disarmStagedDeadline: () => void };
  /**
   * Every durable side effect in the order it happened.
   *
   * The ORDER is the correctness argument on this route (§6.1) — the fence must
   * be durable before anything can act under the epoch, and the provenance must
   * be on disk before the worker can run a gated verb under it — and on a
   * staged dispatch the gap between the write and the act is a human's reaction
   * time rather than a few milliseconds. So the trace is recorded rather than
   * each effect being counted in isolation.
   */
  trace: string[];
  provenance: Array<{ task_id: string | null; epoch: number }>;
  ledger: Array<{ event: string; task_id?: string; epoch?: number; reason?: unknown }>;
  events: Array<Record<string, unknown>>;
  /** Deadlines PARKED by `armDeadlineOnTrigger`, in ms. Never started here. */
  parked: number[];
  disarms: number;
}

function harness(): Harness {
  const em = new EpochManager();
  const state = initialWorkerState({
    worker: "tui-1",
    runId: "2026-09-02T09-00-00Z-stg",
    pid: 1234,
    pgid: 1234,
    startedAt: "2026-09-02T09:00:00Z",
  });
  const trace: string[] = [];
  const provenance: Harness["provenance"] = [];
  const ledger: Harness["ledger"] = [];
  const events: Array<Record<string, unknown>> = [];
  const parked: number[] = [];
  const h = {
    em,
    state,
    trace,
    provenance,
    ledger,
    events,
    parked,
    disarms: 0,
  } as Harness;
  h.deps = {
    em,
    state,
    worker: "tui-1",
    persistFence: async () => {
      trace.push("persistFence");
    },
    flushState: async () => {
      trace.push("flushState");
    },
    writeProvenance: async (task_id, epoch) => {
      trace.push(`writeProvenance(${String(task_id)},${epoch})`);
      provenance.push({ task_id, epoch });
    },
    // ISC-1115 — traced rather than counted, because what has to be true of the
    // release is an ORDER: the drop is disarmed while the epoch is being torn
    // down, not left for whatever runs next.
    clearDispatchDrop: async () => {
      trace.push("clearDispatchDrop");
    },
    ledgerAppend: async (event, fields) => {
      trace.push(`ledger:${event}`);
      ledger.push({
        event,
        task_id: fields.task_id,
        epoch: fields.epoch,
        reason: fields.detail?.["reason"],
      });
    },
    logEvent: (record) => {
      events.push(record);
    },
    armDeadlineOnTrigger: (ms) => {
      trace.push(`park(${ms})`);
      parked.push(ms);
    },
    shuttingDown: false,
    disarmStagedDeadline: () => {
      h.disarms += 1;
      trace.push("disarm");
    },
  };
  return h;
}

// ---------------------------------------------------------------------------
// `stage` — allocation without delivery (D6)
// ---------------------------------------------------------------------------

describe("stage — allocates a real epoch for a dispatch nothing will send (D6)", () => {
  test("the first stage allocates a real epoch, not the placeholder 0", async () => {
    const h = harness();
    const answer = await handleStage(h.deps, envelope("T-001"), "a1", null);

    expect(answer).toEqual({ accepted: true, epoch: 1, replayed: false });
    /**
     * `>= 1` is the claim D6 actually makes, stated separately from the exact
     * number. The route's defect was that BOTH sides of
     * `harvest/outbox.ts`'s envelope correlation carried `0`, so the check
     * passed vacuously; anything a real allocator hands out is at least 1, and
     * an implementation that kept the placeholder fails here rather than only
     * on the equality above.
     */
    expect(answer.accepted && answer.epoch).toBeGreaterThanOrEqual(1);
  });

  /**
   * The refusal NAMES the epoch holding the worker, and that is not cosmetic:
   * the operator's next move is `unstage` against those identifiers, and
   * `cancel` refuses unless they match. A `busy` that said only "busy" would
   * leave them unable to release the thing blocking them.
   */
  test("a second stage of a DIFFERENT task is refused busy, naming the live epoch", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);

    const second = await handleStage(h.deps, envelope("T-002"), "b1", null);
    expect(second).toEqual({ accepted: false, ok: false, reason: "busy", epoch: 1 });

    // Control arm: the refusal is the ALLOCATOR's, so nothing was written on
    // the way to it. An implementation that stamped provenance first and
    // checked afterwards would leave T-002 on disk under T-001's epoch.
    expect(h.provenance).toEqual([{ task_id: "T-001", epoch: 1 }]);
    expect(h.state.task_id).toBe("T-001");
    expect(h.ledger.at(-1)).toEqual({
      event: "stage_rejected",
      task_id: "T-002",
      epoch: undefined,
      reason: "busy",
    });
  });

  /**
   * §6.3's central claim about what the epoch fences on this route: a repeated
   * stage of the same attempt REPLAYS rather than allocating or refusing.
   *
   * `already_completed` would be the wrong answer for the reason `epoch.ts`
   * gives — the caller could not tell "someone else did it" from "I did it and
   * lost the ack" — and a fresh allocation would run the task twice.
   */
  test("re-staging the SAME (task_id, attempt_id) replays the same epoch", async () => {
    const h = harness();
    const first = await handleStage(h.deps, envelope("T-001"), "a1", null);
    const again = await handleStage(h.deps, envelope("T-001"), "a1", null);

    expect(first).toEqual({ accepted: true, epoch: 1, replayed: false });
    expect(again).toEqual({ accepted: true, epoch: 1, replayed: true });

    /**
     * The control arm, and it is the half that matters more than the epoch
     * number.
     *
     * A replay must REWRITE NOTHING. An implementation that fell through to
     * the persist/stamp block would perform a second provenance write on
     * behalf of a stage that already happened — and that second write is the
     * one that can land while the epoch is mid-turn. Counting the effects is
     * how that is caught; the returned epoch is identical either way.
     */
    expect(h.provenance).toHaveLength(1);
    expect(h.trace.filter((t) => t === "persistFence")).toHaveLength(1);
    expect(h.parked).toEqual([1200 * 1000]);
  });

  /**
   * §6.1's ordering, and it is borrowed verbatim from the RPC route's own
   * argument. Asserted as a sequence rather than as three memberships, because
   * every wrong order still performs all three writes.
   */
  test("the fence is durable before the provenance, and both before the state flush", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);

    expect(h.trace.indexOf("persistFence")).toBeLessThan(
      h.trace.indexOf("writeProvenance(T-001,1)"),
    );
    expect(h.trace.indexOf("writeProvenance(T-001,1)")).toBeLessThan(h.trace.indexOf("flushState"));
    expect(h.provenance).toEqual([{ task_id: "T-001", epoch: 1 }]);
    // The provenance carries the ALLOCATOR's epoch, never the envelope's — the
    // envelope's is the schema default 0, which is the value the 2026-08-30
    // regression delivered and the harvest then refused.
    expect(h.provenance[0]?.epoch).not.toBe(0);
  });

  test("state carries the staged task and epoch, and the ledger records the stage", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-007"), "a1", null);

    expect(h.state.task_id).toBe("T-007");
    expect(h.state.epoch).toBe(1);
    expect(h.ledger).toEqual([{ event: "stage_accepted", task_id: "T-007", epoch: 1 }]);
  });
});

// ---------------------------------------------------------------------------
// §9 Q1 — the deadline is parked, not started
// ---------------------------------------------------------------------------

describe("stage — the deadline is parked at stage time, not started (§9 Q1)", () => {
  /**
   * The failure this prevents is D6's second stated cost: `deadline.restart()`
   * and `deadlineMs = envelope.deadline_s * 1000` run at dispatch on the RPC
   * route, which is right there because the turn begins in the same
   * millisecond. A staged epoch's turn begins when a person presses a key, so
   * a 20-minute task staged before lunch would be `timed_out` before it began.
   */
  test("the envelope's deadline is handed to the parking hook, in milliseconds", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001", { deadline_s: 1200 }), "a1", null);
    expect(h.parked).toEqual([1_200_000]);
  });

  /**
   * The control arm for the whole question, and it is a SOURCE claim because
   * the thing being denied is an absence.
   *
   * `handleStage` cannot start a clock it has no reference to — `deadline` and
   * `deadlineMs` are `main`'s locals and are not in `StageDeps`. So the probe
   * that can fail is the one on the supervisor's own text: the only assignment
   * to `deadlineMs` from the staged path is the one inside the transcript
   * poll, at the trigger.
   */
  test("the parked value reaches deadlineMs only at the trigger, inside the poll", () => {
    // The park site sets the HOLDING variable and never the armed one.
    expect(SUPERVISOR).toMatch(/armDeadlineOnTrigger: \(ms\) => \{\s*stagedDeadlineMs = ms;/);
    // The arming site is inside the transcript poll, gated on growth.
    const poll = /const transcriptPoll[\s\S]*?\}, TUI_POLL_MS\);/.exec(SUPERVISOR);
    expect(poll, "the transcript poll could not be located").not.toBeNull();
    const body = poll![0];
    expect(body).toContain("if (stagedDeadlineMs !== null && grew) {");
    expect(body).toContain("deadline.restart();");
    expect(body).toContain("deadlineMs = stagedDeadlineMs;");
    // Parked exactly once: re-arming on every subsequent growth would restart
    // the clock for the whole turn and the deadline would never fire.
    expect(body).toContain("stagedDeadlineMs = null;");
  });

  /**
   * The ambiguity §9 Q1 states, asserted as a documented limitation rather
   * than as behaviour — because it IS a limitation and the SRD requires it be
   * called approximate in those words.
   *
   * Growth after a stage may be the staged task or the operator's own
   * unrelated prompt typed into the same pane, and nothing separates them.
   * A future reader who deletes the word has to delete this too.
   */
  test("the approximation is declared where the deadline is armed", () => {
    const raw = readFileSync(`${ROOT}src/supervisor/index.ts`, "utf8");
    expect(raw).toContain("APPROXIMATE");
    expect(raw).toMatch(/APPROXIMATE[\s\S]{0,400}operator's own prompt/);
  });
});

// ---------------------------------------------------------------------------
// `unstage` — the release (§9 Q8)
// ---------------------------------------------------------------------------

describe("unstage — releases a staged epoch without settling it (§9 Q8)", () => {
  test("a matching, unstarted stage is released and the worker goes idle", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);

    const released = await handleUnstage(h.deps, "T-001", "a1");
    expect(released).toEqual({ ok: true, epoch: 1 });
    expect(h.em.live).toBeNull();
    expect(h.state.phase).toBe("idle");
    expect(h.state.task_id).toBeNull();
    expect(h.state.epoch).toBe(0);
  });

  /**
   * The provenance clear, and it matters MORE here than after a settle.
   *
   * `settle` clears `/policy/task` because a worker process outlives its epoch
   * and anything it runs afterwards belongs to no task. After an unstage the
   * operator is sitting at that terminal and will keep typing, so a stale task
   * id would stamp every gated verb they run with a task that never ran — the
   * ledger would be present, well-formed and wrong in one field, which is the
   * shape ISC-360 records as the reason this file exists.
   */
  test("the provenance is cleared back to (null, 0), before the state reset", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);
    h.trace.length = 0;

    await handleUnstage(h.deps, "T-001", "a1");
    expect(h.provenance.at(-1)).toEqual({ task_id: null, epoch: 0 });
    expect(h.trace.indexOf("persistFence")).toBeLessThan(h.trace.indexOf("writeProvenance(null,0)"));
    expect(h.trace.indexOf("writeProvenance(null,0)")).toBeLessThan(h.trace.indexOf("flushState"));
    // The parked deadline dies with the epoch, or the NEXT stage's first
    // growth would arm the cancelled task's number.
    expect(h.disarms).toBe(1);
  });

  /**
   * ── THE FOURTH CONSEQUENCE, and the only one that is not a stale reading ──
   *
   * `/policy/dispatch` is what `docker/pi-extensions/dispatch-trigger.ts` polls.
   * It fires on a `staged: true` header and dedups in `lastFired` — closure
   * state belonging to one Pi session, which does not survive a `/new`. So an
   * armed drop outliving its epoch is a LOADED TRIGGER, and the next session to
   * start pulls it: the operator's cancellation runs anyway, in a turn nobody
   * asked for and no epoch is waiting on.
   *
   * ISC-1114 is the same mechanism reached through `settle`, and it cost the
   * live triage console a sweep before anyone noticed, because a re-fired task
   * produces correct-looking work and no error at all. `handleUnstage`'s
   * docblock listed three durable consequences and this was the missing fourth.
   *
   * Ordered against `writeProvenance` for the reason the sibling test above
   * gives: what has to be true is that the disarm happens while the epoch is
   * being torn down, not left for whatever runs next.
   */
  test("the dispatch drop is disarmed as part of the release", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);
    h.trace.length = 0;

    await handleUnstage(h.deps, "T-001", "a1");
    expect(
      h.trace,
      "the release left `/policy/dispatch` armed — the next session re-runs the cancelled task",
    ).toContain("clearDispatchDrop");
    expect(h.trace.indexOf("writeProvenance(null,0)")).toBeLessThan(
      h.trace.indexOf("clearDispatchDrop"),
    );
    expect(h.trace.indexOf("clearDispatchDrop")).toBeLessThan(h.trace.indexOf("flushState"));
  });

  /**
   * A drop that will not clear must not take the release with it.
   *
   * By the time this runs the fence has already been mutated, so throwing would
   * leave a released epoch the caller believes is still live — and the refusal
   * the operator is waiting on would never be returned. The failure is logged
   * instead, because "still armed" and "disarmed" producing identical output is
   * exactly how ISC-1114 survived behind a docblock claiming the opposite.
   */
  test("a drop that refuses to clear is logged, and the release still succeeds", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);
    h.deps.clearDispatchDrop = async () => {
      throw new Error("EACCES: the drop is 0444 and the widen failed");
    };

    const released = await handleUnstage(h.deps, "T-001", "a1");
    expect(released.ok, "a failed disarm undid the release").toBe(true);
    const logged = h.events.find((e) => e["type"] === "dispatch_drop_clear_failed");
    expect(logged, "the failed disarm left no trace an operator could find").toBeDefined();
    expect(String(logged?.["detail"])).toContain("EACCES");
  });

  /**
   * The combined claim from §9 Q8, and the one that proves `attempts` was
   * cleared while `last_accepted_epoch` was not rewound.
   *
   * A stage of the SAME attempt after a release must ALLOCATE — a fresh number,
   * above the released one. `replayed: true` here would mean the operator's
   * correction silently re-used the epoch they just released; epoch 1 again
   * would mean the fence rewound, and epochs are never reused.
   */
  test("re-staging the SAME attempt after a release gets a fresh, HIGHER epoch", async () => {
    const h = harness();
    expect(await handleStage(h.deps, envelope("T-001"), "a1", null)).toEqual({
      accepted: true,
      epoch: 1,
      replayed: false,
    });
    await handleUnstage(h.deps, "T-001", "a1");

    expect(await handleStage(h.deps, envelope("T-001"), "a1", null)).toEqual({
      accepted: true,
      epoch: 2,
      replayed: false,
    });
  });

  /**
   * THE ARGUMENT FOR `cancel` OVER `settle("cancelled")`, as the consequence an
   * operator meets.
   *
   * A settle appends to `completed`, and `completed` is what `allocate` reads
   * to answer `already_completed` for a different attempt against the same
   * task id. A cancelled task never ran, so that answer would be a claim of
   * work that did not happen — delivered with a verdict, which the caller has
   * no way to doubt.
   */
  test("a DIFFERENT attempt against the released task_id is not already_completed", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);
    await handleUnstage(h.deps, "T-001", "a1");

    const corrected = await handleStage(h.deps, envelope("T-001"), "a-corrected", null);
    expect(corrected).toEqual({ accepted: true, epoch: 2, replayed: false });
  });

  test("a release naming a DIFFERENT (task_id, attempt_id) is refused, and nothing moves", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);
    h.trace.length = 0;

    const wrongTask = await handleUnstage(h.deps, "T-999", "a1");
    expect(wrongTask.ok).toBe(false);
    expect(refusalReason(wrongTask)).toBe("not_the_live_attempt");
    // The sentence names the epoch actually held, so the operator can retry
    // against the right identifiers rather than guessing.
    expect(wrongTask.ok === false && wrongTask.error).toContain("T-001");

    const wrongAttempt = await handleUnstage(h.deps, "T-001", "a-other");
    expect(refusalReason(wrongAttempt)).toBe("not_the_live_attempt");

    // Control arm: a refusal that nonetheless cleared state would pass a probe
    // reading only the return value. Nothing was written and the epoch stands.
    expect(h.trace).toEqual([]);
    expect(h.em.live).not.toBeNull();
    expect(h.state.task_id).toBe("T-001");
  });

  /**
   * A started epoch is a RUNNING TURN. Releasing it would clear `live` while
   * the agent kept working, so the next allocation's window would open over
   * output this epoch still owns — the §7.5 interleaving, manufactured. The
   * refusal sends the operator to `abort`, which is that job.
   */
  test("a release of a STARTED epoch is refused", async () => {
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);
    h.em.noteAck(10);
    expect(h.em.bindStart(11)).toBe(true);
    h.trace.length = 0;

    const answer = await handleUnstage(h.deps, "T-001", "a1");
    expect(answer.ok).toBe(false);
    expect(refusalReason(answer)).toBe("already_started");
    expect(answer.ok === false && answer.error).toMatch(/abort/);
    expect(h.trace).toEqual([]);
    expect(h.em.windowOpen).toBe(true);
  });

  test("a release with nothing staged is refused rather than silently accepted", async () => {
    const h = harness();
    const answer = await handleUnstage(h.deps, "T-001", "a1");
    expect(refusalReason(answer)).toBe("no_live_epoch");
    expect(h.trace).toEqual([]);
  });

  test("a shutdown's phase survives a release", async () => {
    // `settle` makes the same exception: a shutdown has already decided what
    // the phase means, and a release must not overwrite it with a liveness
    // claim.
    const h = harness();
    await handleStage(h.deps, envelope("T-001"), "a1", null);
    h.deps.shuttingDown = true;
    h.state.phase = "dead";

    await handleUnstage(h.deps, "T-001", "a1");
    expect(h.state.phase).toBe("dead");
  });
});

function refusalReason(answer: UnstageAnswer): string | null {
  return answer.ok ? null : answer.reason;
}

// ---------------------------------------------------------------------------
// D12 — Defect B closes as a consequence
// ---------------------------------------------------------------------------

describe("Defect B closes as a consequence of D6, not as a repair (D12)", () => {
  /**
   * §2.4's finding: `em.allocate` had exactly one caller, the RPC `dispatch`
   * handler, which refuses a `tui` worker 29 lines before reaching it — and
   * `sendViaPane` never reaches the supervisor at all. So `em.live` was null on
   * every poll of every `tui` worker, and everything below the poll's
   * `if (live === null) return;` never executed in production: no
   * `classifyTuiTurn`, no task record, and `pifleet wait` could only time out.
   *
   * The poll's gate is exactly `em.live === null`, so running the verb against
   * a real `EpochManager` and reading `em.live` tests that gate's condition
   * without needing to drive the poll — which cannot be driven from a unit test
   * because it lives inside `main()`.
   */
  test("after a stage, em.live is non-null — the condition the poll gates on", async () => {
    const h = harness();
    expect(h.em.live).toBeNull(); // the state every tui poll saw before D6

    await handleStage(h.deps, envelope("T-001"), "a1", null);

    expect(h.em.live).not.toBeNull();
    expect(h.em.live?.task_id).toBe("T-001");
    expect(h.em.live?.epoch).toBe(1);
    // Not yet STARTED: the poll's baseline branch runs first and binds the
    // turn, so a stage arrives at the gate live-but-unstarted, which is also
    // exactly the state `unstage` requires.
    expect(h.em.live?.started).toBe(false);
    expect(h.em.windowOpen).toBe(false);
  });

  /**
   * The cost D12 accepts, asserted so it cannot be quietly forgotten: the
   * BACKEND-MANAGED `tui` route still allocates nothing, so for that worker the
   * settle path stays dead until the verb is backported (§5.3). The label at
   * the gate is what stops a reader taking the path for live on both routes,
   * in the style `dispatch.ts` uses for its declared-unreachable key loop.
   */
  test("the still-dead route is labelled at the gate, not left to be inferred", () => {
    // Raw, not comment-stripped: the label IS a comment, and this is the one
    // probe in the file whose subject is prose rather than wiring.
    const raw = readFileSync(`${ROOT}src/supervisor/index.ts`, "utf8");
    // Scoped to the transcript poll. `const live = em.live;` also appears in
    // the prose-trip teardown, which is a different gate about a different
    // thing and carries none of this.
    const poll = /const transcriptPoll[\s\S]*?\}, TUI_POLL_MS\);/.exec(raw);
    expect(poll, "the transcript poll could not be located").not.toBeNull();
    const body = poll![0];

    const gate = body.indexOf("const live = em.live;");
    expect(gate, "the epoch gate could not be located").toBeGreaterThan(-1);
    const label = body.slice(0, gate);
    expect(label).toContain("Defect B");
    expect(label).toContain("sendViaPane");
    expect(label).toMatch(/still dead|STILL DEAD/);
  });
});

// ---------------------------------------------------------------------------
// The structural half — what a run cannot show
// ---------------------------------------------------------------------------

describe("stage cannot reach a send, and dispatch's refusal is untouched", () => {
  /**
   * THE MUTATION THIS SHAPE EXISTS TO DEFEAT: "make `stage` fall through to
   * `send`".
   *
   * A `case "stage"` written inline inside `startControlServer` would have
   * `client` in scope typed `RpcClient | null`, so `client.send(...)` is a
   * strict-null error — real, but one narrowing guard away from compiling, and
   * that guard is three words. `handleStage` is at MODULE scope instead, where
   * `client` is not a name and is not a field of `StageDeps`, so the same
   * mutation is `Cannot find name 'client'` and the fix for it is an edit to
   * the dependency type that no reviewer can miss.
   *
   * Probed on the TYPE rather than on the function body, because the type is
   * what would have to change: a `client` field appearing in `StageDeps` is the
   * first move any send-capable `stage` has to make.
   */
  test("StageDeps carries no RPC channel, so stage has nothing to send on", () => {
    const decl = /export interface StageDeps \{([\s\S]*?)\n\}/.exec(SUPERVISOR);
    expect(decl, "StageDeps could not be located").not.toBeNull();
    const body = decl![1] ?? "";
    expect(body).not.toMatch(/client/);
    expect(body).not.toMatch(/RpcClient/);
    expect(body).not.toMatch(/send/);
  });

  test("neither staged verb names a client at all", () => {
    for (const fn of ["handleStage", "handleUnstage"]) {
      const at = SUPERVISOR.indexOf(`export async function ${fn}(`);
      expect(at, `${fn} could not be located`).toBeGreaterThan(-1);
      // To the next top-level `export`/`function`, which is enough of the body
      // for a `send` to have to appear inside.
      const end = SUPERVISOR.indexOf("\nexport ", at + 1);
      const body = SUPERVISOR.slice(at, end === -1 ? SUPERVISOR.length : end);
      expect(body, `${fn} names a client`).not.toMatch(/client/);
      expect(body, `${fn} sends`).not.toMatch(/\.send\(/);
    }
  });

  /**
   * The verbs are WIRED, not merely written — the failure mode
   * `supervisor-tui.test.ts` names in its header: a battery that calls the
   * helper directly stays green through a refactor that stops calling it.
   */
  test("both verbs are reachable from the control socket", () => {
    expect(SUPERVISOR).toContain('case "stage": {');
    expect(SUPERVISOR).toContain('case "unstage": {');
    expect(SUPERVISOR).toMatch(/return await handleStage\(stageDeps\(\), envelope, attemptId/);
    expect(SUPERVISOR).toMatch(/return await handleUnstage\(/);
  });

  /**
   * D6 is explicit that `dispatch`'s own refusal STAYS EXACTLY AS IT IS: it is
   * spelled `if (client === null)` precisely so that deleting it fails to
   * compile, because that is what narrows `client` for the `send` below. The
   * new verb separates allocation from delivery; it does not relax the guard
   * that was conflating them.
   */
  test("the RPC dispatch refusal for a null client is unchanged", () => {
    expect(SUPERVISOR).toContain('const reason = "pane_mode_tui_has_no_rpc_dispatch";');
    // The spelling, not merely the effect. `if (tuiMode)` is behaviourally
    // equivalent by construction and would silently stop narrowing `client`.
    const at = SUPERVISOR.indexOf('const reason = "pane_mode_tui_has_no_rpc_dispatch";');
    const before = SUPERVISOR.slice(Math.max(0, at - 200), at);
    expect(before).toContain("if (client === null) {");

    const raw = readFileSync(`${ROOT}src/supervisor/index.ts`, "utf8");
    expect(raw).toContain(
      "`worker ${argv.workerId} is pane_mode: tui; the supervisor holds no RPC channel to ` +",
    );
  });
});
