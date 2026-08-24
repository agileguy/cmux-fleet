/**
 * `extension_ui_request` handling against a real detached supervisor.
 *
 * SRD §4.2 splits the nine methods into two classes and §12.3 guard 2 gives
 * them opposite treatments: the four DIALOG methods (`select`, `confirm`,
 * `input`, `editor`) block the agent until answered and must be answered
 * `{cancelled:true}` inside `ui_request_timeout`; the five FIRE-AND-FORGET
 * methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`)
 * are waiting on nothing and must be logged and ignored — responding to one is
 * meaningless.
 *
 * ## What each test in this file is for
 *
 * - **ISC-111** — three dialogs (`select`, `confirm`, `input`) block a turn,
 *   and each is answered by a frame correlated to its own request id, inside
 *   the configured bound. The elapsed figure is asserted, not merely the fact.
 * - **ISC-112** — an `editor` request, the one dialog with no self-resolve,
 *   does not hang the run: the turn settles `quiesced` well inside `deadline_s`
 *   rather than being ended by the deadline kill ladder.
 * - **ISC-113** — the five fire-and-forget methods are logged and receive
 *   nothing back, asserted twice: once alone, and once in a run that ALSO
 *   contains a dialog that does get answered.
 * - **Probe integrity** — the double really does hang on an unanswered dialog,
 *   proved against `fake-pi.ts` directly with no supervisor in the picture.
 *
 * ## Why the last one exists, and why it is not decoration
 *
 * Every assertion above rests on one unverified claim: that a dialog HOLDS the
 * turn. If it does not — if the double emits an `editor` request and finishes
 * the turn anyway — then ISC-112 passes on a supervisor that answers nothing,
 * ISC-111's dialogs unblock themselves, and the whole file is green while the
 * criteria are false. ISA.md's ISC-112 note names this exact outcome: "a
 * scenario that emits an `editor` request and then finishes anyway would
 * produce a green test proving only that the double does not block… any pass
 * here is a false one."
 *
 * That claim cannot be checked by the supervisor-driven tests, because once the
 * responder exists every dialog gets answered and a non-blocking double would
 * be indistinguishable from a blocking one. So it is checked where it can be:
 * a direct probe drives the double, withholds an answer, and asserts the turn
 * does NOT end — then supplies an answer and asserts that it does. That probe
 * depends on nothing in `src/supervisor`, which is the point; it is the
 * evidence that the other three probes are capable of failing at all
 * (Docs/SRD-COMPLETION.md §8 rule 4).
 *
 * ## Where the evidence is read from
 *
 * The negative — "nothing was sent for these five" — is observed from the FAR
 * END of the wire, through fake-pi's `PIFLEET_FAKE_REQUEST_LOG`. Nothing in the
 * run directory can carry it: `events.jsonl` records what the supervisor
 * RECEIVED, and a message never sent leaves no trace on disk at all.
 *
 * The timing — ISC-111's "elapsed < `ui_request_timeout`" — is read from
 * fake-pi's `PIFLEET_FAKE_DIALOG_LOG`, for the same reason from the other
 * direction. The request log has no timestamps, so a test reading only that
 * could time a dialog no better than its own 50 ms polling interval; the double
 * knows to the millisecond when it wrote the request and when the answer
 * landed, and it is the only party that does. That log also records HOW each
 * dialog stopped blocking, which is what stops a scenario's own
 * `self_resolve_ms` being mistaken for a supervisor answering.
 *
 * ## What is deliberately not asserted
 *
 * The literal wire shape of a UI response. Pi's response frame is not written
 * down in the SRD and was recovered from the shipped docs inside the pinned
 * image by the supervisor work; hard-coding it here would make this file assert
 * a guess and go red on a correct implementation that chose a different key. So
 * every assertion is on OBSERVABLE FACTS instead: a frame addressed to this
 * request id reached the child's stdin, no frame addressed to those five ids
 * did, and the answer carries `cancelled === true` somewhere in it. Those
 * survive whatever frame the implementation lands on.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskEnvelopeSchema, type TaskEnvelope } from "../../src/contracts.ts";
import { TimersSchema } from "../../src/config/schema.ts";
import { runPaths, taskRecordPath, workerPaths } from "../../src/run/paths.ts";
import { readTaskRecord, readWorkerState } from "../../src/run/state.ts";
import { processStartTime } from "../../src/run/registry.ts";
import { controlCall, processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";
import { gateBudget } from "../support/budget.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");

/**
 * The bound ISC-111 is measured against, derived rather than restated.
 *
 * `timers.ui_request_timeout` prefaults to `5s` — the very five seconds the
 * criterion names — and the supervisor falls back to that same prefault when a
 * run directory records no value, which is exactly this file's situation: these
 * tests launch the supervisor directly rather than through `up`, so no
 * `run.json` carries an override. Reading the schema means the test and the
 * production default cannot drift apart; a literal `5_000` here would be
 * correct today and silently wrong the first time the prefault moves.
 */
const UI_REQUEST_TIMEOUT_MS = TimersSchema.parse({}).ui_request_timeout * 1000;

/**
 * The five fire-and-forget methods, in the order the scenarios emit them, with
 * the request ids an answer would have to be addressed to.
 *
 * Named here rather than derived from the scenario file so the test states the
 * SRD's vocabulary itself: a scenario silently losing a method would otherwise
 * shrink what is asserted without failing anything. Both `ui-fire-and-forget`
 * and `ui-mixed` use these same ids so the two tests read one list.
 */
const FIRE_AND_FORGET: ReadonlyArray<{ id: string; method: string }> = [
  { id: "uireq-notify", method: "notify" },
  { id: "uireq-setstatus", method: "setStatus" },
  { id: "uireq-setwidget", method: "setWidget" },
  { id: "uireq-settitle", method: "setTitle" },
  { id: "uireq-seteditortext", method: "set_editor_text" },
];

/** The three self-resolving dialog methods, as `ui-dialogs.json` emits them. */
const DIALOGS: ReadonlyArray<{ id: string; method: string }> = [
  { id: "uireq-select", method: "select" },
  { id: "uireq-confirm", method: "confirm" },
  { id: "uireq-input", method: "input" },
];

/**
 * Every command the supervisor legitimately sends to its Pi process, read off
 * `src/supervisor/index.ts`: the readiness and completion probes, the prompt,
 * and the two control verbs.
 *
 * The allowlist — rather than only checking that no request carries a UI id —
 * is what catches an answer sent under a shape nobody predicted. A responder
 * might address the request by id, echo it in a `params` field, or reply with
 * a bare `{"type":"response"}`; only "the supervisor sent nothing that is not
 * one of its own commands" covers all three. Adding a genuine new supervisor
 * command means adding it here, deliberately, which is the review this list is
 * for.
 *
 * A dialog ANSWER is not on this list and must not be. In the runs that contain
 * a dialog the answer is exempted by being addressed to that dialog's id — an
 * exemption granted per-id, so a responder that answered a dialog correctly and
 * a fire-and-forget request as well still fails.
 */
const SUPERVISOR_COMMANDS = new Set([
  "get_state",
  "get_session_stats",
  "get_last_assistant_text",
  "prompt",
  "steer",
  "abort",
]);

// ---------------------------------------------------------------------------
// Budgets — derived from the gates each test actually waits on (ISC-273/274)
// ---------------------------------------------------------------------------

/**
 * How long a worker gets to reach `idle` after being launched.
 *
 * Matches the sibling supervisor-driven tests. Measured idle cost for this
 * step is ~1.4 s, so the gate already carries better than an order of magnitude
 * of headroom for contention.
 */
const READY_GATE_MS = 20_000;

/**
 * How long a dispatched task gets to produce a task record.
 *
 * Sized so the SLOWEST FAILING path still lands inside it, because every gate
 * here is a `waitFor` that returns false rather than throwing — a run that
 * blows its gate fails on a named assertion, and a run that blows the test's
 * wall-clock budget fails on an opaque timeout. The three failure paths this
 * has to outlast: an unanswered `ui-dialogs` run self-resolves three dialogs at
 * 8 s each and settles at ~26 s; an unanswered `ui-editor` run burns its 20 s
 * `deadline_s` plus the supervisor's 5 s abort grace and settles ~25 s; an
 * unanswered `ui-mixed` run self-resolves once and settles at ~10 s.
 */
const SETTLE_GATE_MS = 40_000;

/**
 * The wall-clock ceilings in this file are `gateBudget(...)` over the gates
 * each test actually waits on — see `test/support/budget.ts`, which carries the
 * full argument for why NEITHER `cliBudget` NOR `containerBudget` governs here:
 * nothing in this file runs the pifleet CLI, and nothing starts a container.
 * The gates above are the cost, so the gates are what the ceiling is built from.
 */

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

async function freshRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-uireq-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

// Unique per process: the control socket derives from (run_id, worker) in the
// shared os.tmpdir(), and a hardcoded id collides across test processes.
const RUN_TAG = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const testRunId = (name: string): string => `uireq-${name}-${RUN_TAG}`;

const piCommand = (scenario: string): string =>
  `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, scenario)}`;

async function waitFor(cond: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    if (await cond()) return true;
    if (performance.now() - start > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

async function launchWorker(
  root: string,
  runId: string,
  scenario: string,
  logs: { requestLog: string; dialogLog?: string },
): Promise<{ pid: number; pgid: number }> {
  const res = await processLauncher.launchDetached({
    runId,
    runDir: join(root, runId),
    workerId: "eng-1",
    argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
    // The double inherits the supervisor's environment (it is spawned with no
    // `env` override), which is how both log paths reach it.
    env: {
      PIFLEET_PI_COMMAND: piCommand(scenario),
      PIFLEET_FAKE_REQUEST_LOG: logs.requestLog,
      ...(logs.dialogLog === undefined ? {} : { PIFLEET_FAKE_DIALOG_LOG: logs.dialogLog }),
    },
    logPath: join(root, runId, "workers", "eng-1", "supervisor.log"),
  });
  cleanups.push(async () => {
    try {
      process.kill(-res.pgid, "SIGKILL");
    } catch {
      try {
        process.kill(res.pid, "SIGKILL");
      } catch {
        // Already gone.
      }
    }
  });
  return res;
}

function makeEnvelope(
  runId: string,
  taskId: string,
  opts: { brief: string; deadlineS: number },
): TaskEnvelope {
  return TaskEnvelopeSchema.parse({
    schema: "pifleet.task/v1",
    task_id: taskId,
    run_id: runId,
    epoch: 0,
    attempt: 1,
    worker: "eng-1",
    dispatched_at: new Date().toISOString(),
    title: "ui request task",
    brief: opts.brief,
    repo: "unset",
    host_workdir: "unset",
    container_workdir: "/workspace",
    branch: `fleet/${runId}/eng-1`,
    base_ref: "0".repeat(40),
    outbox: `/outbox/${taskId}`,
    deadline_s: opts.deadlineS,
  });
}

async function readJsonl(path: string): Promise<Array<Record<string, unknown>>> {
  const text = await Bun.file(path)
    .text()
    .catch(() => "");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

/** The `extension_ui_request` events the supervisor recorded, in order. */
async function loggedUiRequests(
  eventsPath: string,
): Promise<Array<Record<string, unknown>>> {
  const events = await readJsonl(eventsPath);
  return events
    .filter((e) => e["type"] === "event")
    .map((e) => e["event"] as Record<string, unknown> | undefined)
    .filter((e): e is Record<string, unknown> => e?.["type"] === "extension_ui_request");
}

/**
 * Whether `value` mentions `id` anywhere in its VALUES, at any depth.
 *
 * The same shape-blind correlation rule fake-pi uses, restated here rather than
 * imported, and the duplication is deliberate: the double's copy decides what
 * unblocks a dialog, and this copy decides what the test believes it saw. If
 * they were one function a bug in it would move both the behaviour and the
 * assertion together, and the test would agree with the double about a wrong
 * answer. Two independent readings of the same wire is the whole point.
 */
function mentionsId(value: unknown, id: string): boolean {
  if (typeof value === "string") return value === id;
  if (Array.isArray(value)) return value.some((v) => mentionsId(v, id));
  if (value !== null && typeof value === "object") {
    return Object.values(value as Record<string, unknown>).some((v) => mentionsId(v, id));
  }
  return false;
}

/**
 * Whether `value` carries `cancelled: true` anywhere in it.
 *
 * ISC-111 says the answer is `{cancelled:true}`; it does not say at what depth,
 * and the SRD does not state the frame. Asserting the FACT (this answer says
 * cancelled) rather than the SHAPE (`frame.cancelled === true` on a literal
 * top-level key) is what lets this survive an implementation that nests the
 * payload under `data` or `result`. A supervisor that answered `{cancelled:
 * false}`, or answered with a value, still fails.
 */
function saysCancelled(value: unknown): boolean {
  if (Array.isArray(value)) return value.some(saysCancelled);
  if (value === null || typeof value !== "object") return false;
  const obj = value as Record<string, unknown>;
  if (obj["cancelled"] === true) return true;
  return Object.values(obj).some(saysCancelled);
}

interface DialogRecord {
  event: string;
  id: string;
  method: string;
  elapsed_ms?: number;
  unblocked_by?: string;
  response?: unknown;
}

async function readDialogLog(path: string): Promise<DialogRecord[]> {
  return (await readJsonl(path)) as unknown as DialogRecord[];
}

function unblockedRecord(log: DialogRecord[], id: string): DialogRecord | undefined {
  return log.find((r) => r.event === "dialog_unblocked" && r.id === id);
}

// ===========================================================================
// ISC-111 — a dialog is answered `{cancelled:true}` inside `ui_request_timeout`
// ===========================================================================

describe("extension_ui_request — dialog methods are answered and bounded (ISC-111)", () => {
  test(
    "select, confirm and input each get a correlated answer inside the timeout",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("dialogs");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      const requestLog = join(root, "fake-pi-requests.jsonl");
      const dialogLog = join(root, "fake-pi-dialogs.jsonl");
      const { pid } = await launchWorker(root, runId, "ui-dialogs.json", {
        requestLog,
        dialogLog,
      });

      expect(
        await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", READY_GATE_MS),
      ).toBe(true);

      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        // `deadline_s` is generous ON PURPOSE here. The discriminator for this
        // criterion is the per-dialog elapsed figure, not the deadline, and a
        // tight deadline would let the kill ladder end an unanswered run before
        // the scenario's own self-resolve did — replacing the diagnosis this
        // test wants ("nobody answered") with a different one ("it timed out").
        envelope: makeEnvelope(runId, "T-UIREQ-DIALOG", {
          brief: "emit three blocking dialog requests mid-turn",
          deadlineS: 90,
        }),
        attempt_id: "uireq-dialog-attempt-1",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      // The turn must actually finish, and finishing is itself evidence: every
      // dialog blocks the emission sequence, so a task record can only exist if
      // all three stopped blocking.
      expect(
        await waitFor(
          async () => (await readTaskRecord(taskRecordPath(wp, "T-UIREQ-DIALOG"))) !== null,
          SETTLE_GATE_MS,
        ),
      ).toBe(true);
      const record = await readTaskRecord(taskRecordPath(wp, "T-UIREQ-DIALOG"));
      expect(record?.verdict).toBe("success");
      expect(record?.reason).toBe("quiesced");

      // ---- The supervisor saw all three ---------------------------------
      const uiEvents = await loggedUiRequests(wp.eventsJsonl);
      expect(uiEvents.map((e) => ({ id: e["id"], method: e["method"] }))).toEqual(
        DIALOGS.map((d) => ({ id: d.id, method: d.method })),
      );

      // ---- Each one was ANSWERED, not self-resolved ----------------------
      const dialogs = await readDialogLog(dialogLog);
      // Non-empty first, or every assertion below would be satisfied by a
      // double that never wrote the log at all.
      expect(
        dialogs.filter((r) => r.event === "dialog_emitted").map((r) => r.id),
      ).toEqual(DIALOGS.map((d) => d.id));

      for (const dialog of DIALOGS) {
        const unblocked = unblockedRecord(dialogs, dialog.id);
        expect(unblocked, `no dialog_unblocked record for ${dialog.id}`).toBeDefined();
        // THE assertion that keeps this non-vacuous. `self_resolve` means the
        // fixture's own timer ended the block and the supervisor answered
        // nothing; `cancelled` means an abort tore the turn down. Only
        // `response` means a frame arrived addressed to this request.
        expect(
          unblocked?.unblocked_by,
          `${dialog.method} (${dialog.id}) was not unblocked by a response`,
        ).toBe("response");

        // ISC-111's literal bound, measured by the party that can: the double
        // timestamps the write and the answer itself. The margin is large in
        // practice — the supervisor answers promptly rather than waiting out
        // its own timer — and asserting the bound rather than the margin is
        // deliberate, because the bound is what the criterion says.
        const elapsed = unblocked?.elapsed_ms ?? Number.POSITIVE_INFINITY;
        expect(
          elapsed,
          `${dialog.method} answered after ${elapsed}ms, bound is ${UI_REQUEST_TIMEOUT_MS}ms`,
        ).toBeLessThan(UI_REQUEST_TIMEOUT_MS);

        // Correlated to THIS request, and saying `cancelled`. Asserted on the
        // recorded frame rather than on a literal string, so a differently
        // keyed but correct answer passes and a wrong answer does not.
        expect(mentionsId(unblocked?.response, dialog.id)).toBe(true);
        expect(
          saysCancelled(unblocked?.response),
          `answer to ${dialog.id} does not say cancelled: ${JSON.stringify(unblocked?.response)}`,
        ).toBe(true);
      }

      // ---- Cross-check from the wire itself ------------------------------
      // The dialog log is the double's own account; the request log is the raw
      // bytes the supervisor wrote. They must agree, or the double invented an
      // answer nobody sent.
      const sent = await readJsonl(requestLog);
      expect(sent.some((m) => m["type"] === "prompt")).toBe(true);
      for (const dialog of DIALOGS) {
        expect(
          sent.filter((m) => mentionsId(m, dialog.id)).length,
          `nothing addressed to ${dialog.id} reached the child's stdin`,
        ).toBeGreaterThan(0);
      }

      // ---- The counter §12.3 guard 2 exists to move ----------------------
      // `WorkerState.ui_requests` is `{answered, denied}` and a `{cancelled:
      // true}` reply is arguably either, so the SUM is what is asserted: the
      // criterion is that answering a dialog is accounted for at all, and
      // pinning the arm would be this test inventing a classification the SRD
      // does not state.
      const state = await readWorkerState(wp);
      const counted = (state?.ui_requests.answered ?? 0) + (state?.ui_requests.denied ?? 0);
      expect(counted, "ui_requests did not move off its default").toBeGreaterThanOrEqual(
        DIALOGS.length,
      );

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    gateBudget([READY_GATE_MS, SETTLE_GATE_MS]),
  );
});

// ===========================================================================
// ISC-112 — an `editor` request does not hang the run
// ===========================================================================

describe("extension_ui_request — an editor request does not hang the run (ISC-112)", () => {
  test(
    "the turn settles quiesced well inside deadline_s rather than being ended by it",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("editor");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      const requestLog = join(root, "fake-pi-requests.jsonl");
      const dialogLog = join(root, "fake-pi-dialogs.jsonl");
      const { pid } = await launchWorker(root, runId, "ui-editor.json", {
        requestLog,
        dialogLog,
      });

      expect(
        await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", READY_GATE_MS),
      ).toBe(true);

      /**
       * A SHORT deadline, and it is the instrument rather than a convenience.
       *
       * `ui-editor.json` has no `self_resolve_ms`, because `editor` has no
       * self-resolve — so against a supervisor with no responder this turn
       * blocks until the deadline fires, the advisory `abort` goes unanswered,
       * and the run settles `timed_out` / `deadline_exceeded_no_terminal_event`
       * about five seconds later. That is the failure ISC-112 describes in as
       * many words, and 20 s is short enough for the test to WITNESS it and
       * name it, rather than dying of its own budget with nothing to report.
       *
       * It is also four times the answer bound, which is what "well inside"
       * has to mean for the pass to be worth anything.
       */
      const deadlineS = 20;
      const dispatchedAt = performance.now();
      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "T-UIREQ-EDITOR", {
          brief: "emit an editor request that blocks the turn until answered",
          deadlineS,
        }),
        attempt_id: "uireq-editor-attempt-1",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      expect(
        await waitFor(
          async () => (await readTaskRecord(taskRecordPath(wp, "T-UIREQ-EDITOR"))) !== null,
          SETTLE_GATE_MS,
        ),
      ).toBe(true);
      const settledAfterMs = performance.now() - dispatchedAt;
      const record = await readTaskRecord(taskRecordPath(wp, "T-UIREQ-EDITOR"));

      // The criterion, stated as the outcomes it excludes.
      //
      // THE VERDICT IS THE DISCRIMINATOR, not the reason, and the difference is
      // easy to get backwards. A hung `editor` turn burns `deadline_s`, and the
      // supervisor then sends an advisory `abort`; because fake-pi honours an
      // abort by ending the turn, the run QUIESCES — and settles
      // `timed_out`/`quiesced`. `reason` alone therefore cannot tell a turn that
      // completed from a turn the kill ladder completed for it, and a test
      // asserting only `quiesced` would go green on the exact failure ISC-112
      // is about. (`deadline_exceeded_no_terminal_event` is the other half of
      // that ladder, for an agent that ignores the abort as well; it is
      // excluded below.) Verdict first, because it is the assertion that
      // carries the criterion.
      expect(
        record?.verdict,
        `editor turn settled '${record?.verdict}'/'${record?.reason}' after ${Math.round(settledAfterMs)}ms of a ${deadlineS}s deadline`,
      ).toBe("success");
      expect(record?.reason).toBe("quiesced");

      // "Well inside `deadline_s`" as a number rather than an adjective. Half
      // the deadline is the loosest reading that still excludes a run rescued
      // at the last moment; the answer bound is 5 s, so a correct supervisor
      // lands nowhere near this.
      expect(
        settledAfterMs,
        `editor turn took ${Math.round(settledAfterMs)}ms of a ${deadlineS}s deadline`,
      ).toBeLessThan((deadlineS * 1000) / 2);

      // The turn genuinely continued PAST the dialog: `turn_end` and
      // `agent_end` sit after it in the scenario's emission sequence and are
      // therefore unreachable until it unblocks.
      const events = await readJsonl(wp.eventsJsonl);
      const types = events
        .filter((e) => e["type"] === "event")
        .map((e) => (e["event"] as Record<string, unknown> | undefined)?.["type"]);
      expect(types).toContain("extension_ui_request");
      expect(types).toContain("turn_end");
      expect(types).toContain("agent_end");

      // And it was the SUPERVISOR that unblocked it. With no self-resolve on
      // this dialog the only other way out is an abort, which would have shown
      // up as a different verdict — but asserting the unblocker directly means
      // the test does not have to reason about that at all.
      const unblocked = unblockedRecord(await readDialogLog(dialogLog), "uireq-editor");
      expect(unblocked?.unblocked_by).toBe("response");
      expect(saysCancelled(unblocked?.response)).toBe(true);
      expect(unblocked?.elapsed_ms ?? Number.POSITIVE_INFINITY).toBeLessThan(
        UI_REQUEST_TIMEOUT_MS,
      );

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    gateBudget([READY_GATE_MS, SETTLE_GATE_MS]),
  );
});

// ===========================================================================
// ISC-113 — fire-and-forget receives no response, and is logged
// ===========================================================================

describe("extension_ui_request — fire-and-forget methods (ISC-113)", () => {
  test(
    "every fire-and-forget method is logged and none receives a response",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("faf");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      const requestLog = join(root, "fake-pi-requests.jsonl");
      const { pid } = await launchWorker(root, runId, "ui-fire-and-forget.json", { requestLog });

      expect(
        await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", READY_GATE_MS),
      ).toBe(true);

      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "T-UIREQ-1", {
          brief: "emit fire-and-forget UI requests mid-turn",
          deadlineS: 300,
        }),
        attempt_id: "uireq-attempt-1",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      // The turn must actually finish. A run that hung here would fail the
      // "logged" assertion below for the wrong reason, so settlement is
      // established first and on its own terms.
      expect(
        await waitFor(
          async () => (await readTaskRecord(taskRecordPath(wp, "T-UIREQ-1"))) !== null,
          SETTLE_GATE_MS,
        ),
      ).toBe(true);
      const record = await readTaskRecord(taskRecordPath(wp, "T-UIREQ-1"));
      expect(record?.verdict).toBe("success");
      expect(record?.reason).toBe("quiesced");

      // ---- Clause 1: "and are logged" -----------------------------------
      const uiEvents = await loggedUiRequests(wp.eventsJsonl);

      // Verbatim, in order, with the method AND the id intact — a log that
      // recorded "a UI request happened" without saying which one could not
      // tell a dialog from a notification after the fact, which is the whole
      // distinction §12.3 turns on.
      expect(uiEvents.map((e) => ({ id: e["id"], method: e["method"] }))).toEqual(
        FIRE_AND_FORGET.map((m) => ({ id: m.id, method: m.method })),
      );
      // The payload survives too: `params` is what a human reading the log
      // needs to know what the extension was asking for.
      expect(uiEvents[0]?.["params"]).toEqual({ message: "worker is thinking" });

      // ---- Clause 2: "receive no response" ------------------------------
      const sent = await readJsonl(requestLog);
      // The log must be non-empty, or "nothing was sent about these" would be
      // satisfied by a plumbing failure that recorded nothing at all.
      expect(sent.length).toBeGreaterThan(0);
      expect(sent.some((m) => m["type"] === "prompt")).toBe(true);

      const unexpected = sent.filter((m) => !SUPERVISOR_COMMANDS.has(String(m["type"])));
      expect(
        unexpected,
        `the supervisor wrote something that is not one of its own commands: ${JSON.stringify(unexpected)}`,
      ).toEqual([]);

      // And nothing it did send is addressed to a UI request, under any key.
      const addressed = sent.filter((m) =>
        FIRE_AND_FORGET.some((f) => mentionsId(m, f.id)),
      );
      expect(
        addressed,
        `the supervisor addressed a fire-and-forget UI request: ${JSON.stringify(addressed)}`,
      ).toEqual([]);

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    gateBudget([READY_GATE_MS, SETTLE_GATE_MS]),
  );

  test(
    "in one run with both classes, the dialog is answered and the five are not",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("mixed");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      const requestLog = join(root, "fake-pi-requests.jsonl");
      const dialogLog = join(root, "fake-pi-dialogs.jsonl");
      const { pid } = await launchWorker(root, runId, "ui-mixed.json", {
        requestLog,
        dialogLog,
      });

      expect(
        await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", READY_GATE_MS),
      ).toBe(true);

      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "T-UIREQ-MIXED", {
          brief: "emit both UI request classes in one turn",
          deadlineS: 60,
        }),
        attempt_id: "uireq-mixed-attempt-1",
        requested_epoch: null,
      });
      expect(reply["accepted"]).toBe(true);

      expect(
        await waitFor(
          async () => (await readTaskRecord(taskRecordPath(wp, "T-UIREQ-MIXED"))) !== null,
          SETTLE_GATE_MS,
        ),
      ).toBe(true);
      const record = await readTaskRecord(taskRecordPath(wp, "T-UIREQ-MIXED"));
      expect(record?.verdict).toBe("success");
      expect(record?.reason).toBe("quiesced");

      // ---- All six were logged, in order, both classes intermixed --------
      const uiEvents = await loggedUiRequests(wp.eventsJsonl);
      expect(uiEvents.map((e) => e["method"])).toEqual([
        "notify",
        "setStatus",
        "confirm",
        "setWidget",
        "setTitle",
        "set_editor_text",
      ]);

      // ---- The DISCRIMINATION, which is the point of this test -----------
      const sent = await readJsonl(requestLog);
      expect(sent.some((m) => m["type"] === "prompt")).toBe(true);

      // The dialog got a frame…
      const answeredDialog = sent.filter((m) => mentionsId(m, "uireq-confirm"));
      expect(
        answeredDialog.length,
        "the dialog in a mixed run received no answer, so 'the five got none' proves nothing",
      ).toBeGreaterThan(0);

      // …and it really was an answer, rather than the fixture timing out. This
      // is what promotes the negative clause below from a characterisation of
      // an absence into a discrimination: in this run the supervisor
      // demonstrably CAN write to the child, and chose not to for these five.
      const unblocked = unblockedRecord(await readDialogLog(dialogLog), "uireq-confirm");
      expect(unblocked?.unblocked_by).toBe("response");
      expect(saysCancelled(unblocked?.response)).toBe(true);

      // …while none of the five did, individually named so a failure says which.
      for (const method of FIRE_AND_FORGET) {
        const addressed = sent.filter((m) => mentionsId(m, method.id));
        expect(
          addressed,
          `${method.method} (${method.id}) was answered: ${JSON.stringify(addressed)}`,
        ).toEqual([]);
      }

      // Nothing on the wire is unaccounted for: every line is either one of the
      // supervisor's own commands or the answer to the one dialog. A responder
      // that also emitted, say, an unaddressed acknowledgement per UI event
      // would pass every assertion above and fail this one.
      const unaccounted = sent.filter(
        (m) => !SUPERVISOR_COMMANDS.has(String(m["type"])) && !mentionsId(m, "uireq-confirm"),
      );
      expect(
        unaccounted,
        `the supervisor wrote something that is neither a command nor the dialog answer: ${JSON.stringify(unaccounted)}`,
      ).toEqual([]);

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    gateBudget([READY_GATE_MS, SETTLE_GATE_MS]),
  );
});

// ===========================================================================
// Probe integrity — the double genuinely hangs on an unanswered dialog
// ===========================================================================

/**
 * How long the double is watched for an `agent_end` it must NOT emit.
 *
 * `ui-editor.json` emits `turn_end` and `agent_end` on the two lines after the
 * dialog with no intervening delay, so a non-blocking double produces them in
 * the same tick. A window of 1.5 s is three orders of magnitude more than that
 * costs; it is generous because the cost of a false accusation here is a
 * confusing failure, and the cost of the window being too short is a probe that
 * agrees with a broken double.
 */
const NO_END_WINDOW_MS = 1_500;

/** How long the double gets to finish the turn once an answer is supplied. */
const ANSWER_GATE_MS = 5_000;

describe("fake-pi withholds the turn on an unanswered dialog (ISC-111/112 probe integrity)", () => {
  test(
    "an editor dialog blocks agent_end until a correlated frame arrives",
    async () => {
      const root = await freshRoot();
      const dialogLog = join(root, "dialogs.jsonl");

      // The fake Pi directly, with NO supervisor: the claim under test is a
      // property of the double, and involving the supervisor would make a
      // failure ambiguous between the two.
      const proc = Bun.spawn(
        [
          process.execPath,
          FAKE_PI,
          "--scenario",
          join(SCENARIOS, "ui-editor.json"),
          "--session-dir",
          join(root, "sessions"),
          "--session-id",
          "probe",
        ],
        {
          stdin: "pipe",
          stdout: "pipe",
          stderr: "ignore",
          env: { ...process.env, PIFLEET_FAKE_DIALOG_LOG: dialogLog },
        },
      );
      cleanups.push(async () => {
        try {
          proc.kill("SIGKILL");
        } catch {
          // Already gone.
        }
      });

      const lines: Array<Record<string, unknown>> = [];
      void (async () => {
        const reader = proc.stdout.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const parts = buffered.split("\n");
          buffered = parts.pop() ?? "";
          for (const part of parts) {
            if (part.trim() === "") continue;
            try {
              lines.push(JSON.parse(part) as Record<string, unknown>);
            } catch {
              // A partial or malformed record is not this probe's subject.
            }
          }
        }
      })();

      const seen = (type: string): boolean => lines.some((l) => l["type"] === type);

      proc.stdin.write(`${JSON.stringify({ type: "prompt", id: "p1", message: "go" })}\n`);
      proc.stdin.flush();

      // The dialog is emitted…
      expect(await waitFor(async () => seen("extension_ui_request"), ANSWER_GATE_MS)).toBe(true);

      // …and then NOTHING, for a window many times longer than an unblocked
      // sequence would take. This is the assertion the whole file rests on: if
      // it fails, the double does not block, and ISC-111/112 cannot be proved
      // by any test in this file no matter how green they run.
      await new Promise((r) => setTimeout(r, NO_END_WINDOW_MS));
      expect(
        lines.map((l) => l["type"]),
        "fake-pi finished the turn without an answer — a dialog that does not block is not a dialog",
      ).not.toContain("agent_end");
      expect(lines.map((l) => l["type"])).not.toContain("turn_end");

      // Now answer it — with a DELIBERATELY ODD frame. The double's rule is
      // "this message mentions the request id somewhere in its values", and
      // using the shape a real supervisor sends would leave that untested: a
      // double secretly keying on a hard-coded `{"type":"extension_ui_response",
      // "id":...}` would pass. Nesting the id under an unexpected key proves the
      // correlation is shape-blind, which is what lets these tests survive
      // whatever frame Pi's docs turn out to specify.
      proc.stdin.write(
        `${JSON.stringify({ type: "some_answer", payload: { request_id: "uireq-editor" }, cancelled: true })}\n`,
      );
      proc.stdin.flush();

      expect(
        await waitFor(async () => seen("agent_end"), ANSWER_GATE_MS),
        "fake-pi did not resume after the dialog was answered",
      ).toBe(true);
      expect(seen("turn_end")).toBe(true);

      // The double's own account agrees, which also exercises the dialog log
      // the two supervisor-driven tests above read their timings from.
      const unblocked = unblockedRecord(await readDialogLog(dialogLog), "uireq-editor");
      expect(unblocked?.unblocked_by).toBe("response");
      expect(unblocked?.method).toBe("editor");
      expect(mentionsId(unblocked?.response, "uireq-editor")).toBe(true);

      // The answer must not have been echoed back as a command. `resolveDialog`
      // consumes it precisely so the double does not invent traffic on the wire
      // ISC-113 asserts silence about.
      expect(lines.filter((l) => l["command"] === "some_answer")).toEqual([]);

      proc.stdin.end();
      await proc.exited;
    },
    gateBudget([NO_END_WINDOW_MS, ANSWER_GATE_MS, ANSWER_GATE_MS]),
  );
});
