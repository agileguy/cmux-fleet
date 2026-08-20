/**
 * `extension_ui_request` handling against a real detached supervisor.
 *
 * SRD §4.2 splits the nine methods into two classes and §12.3 guard 2 gives
 * them opposite treatments: the four DIALOG methods (`select`, `confirm`,
 * `input`, `editor`) block the agent until answered and must be answered
 * `{cancelled:true}` after `ui_request_timeout`; the five FIRE-AND-FORGET
 * methods (`notify`, `setStatus`, `setWidget`, `setTitle`, `set_editor_text`)
 * are waiting on nothing and must be logged and ignored — responding to one is
 * meaningless.
 *
 * ONLY THE FIRE-AND-FORGET HALF IS TESTED HERE, and the omission is the
 * honest one rather than an oversight. ISC-111 ("a dialog request is answered
 * `{cancelled:true}` within 5s") and ISC-112 ("an `editor` request does not
 * hang the run") describe an auto-responder that does not exist: `grep -rn
 * 'extension_ui' src/` finds no handler, `ui_request_timeout` is parsed by
 * `config/schema.ts` and read by nobody, and `WorkerState.ui_requests` is a
 * counter nothing increments. A test for either would be a test of an absence,
 * so they stay open in ISA.md instead.
 *
 * WHAT THIS FILE THEREFORE PROVES, AND WHAT IT DOES NOT. It proves ISC-113's
 * two clauses literally: every fire-and-forget request reaches `events.jsonl`
 * verbatim, and the supervisor writes nothing back for any of them. It does
 * NOT prove the supervisor DISTINGUISHES the two classes — today it answers
 * nothing at all, so the "no response" clause holds because no responder
 * exists rather than because one classified these five correctly. That is
 * exactly why the criterion is graded `[~]`. The guard still earns its place:
 * when guard 2 is built, an implementation that answers all nine turns this
 * test red, which is the mistake the two-class split exists to prevent.
 *
 * The negative clause is observed from the FAR END of the wire, through
 * fake-pi's `PIFLEET_FAKE_REQUEST_LOG`. Nothing in the run directory can carry
 * it: `events.jsonl` records what the supervisor RECEIVED, and a message never
 * sent leaves no trace on disk at all.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskEnvelopeSchema, type TaskEnvelope } from "../../src/contracts.ts";
import { runPaths, taskRecordPath, workerPaths } from "../../src/run/paths.ts";
import { readTaskRecord, readWorkerState } from "../../src/run/state.ts";
import { processStartTime } from "../../src/run/registry.ts";
import { controlCall, processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");

/**
 * The five fire-and-forget methods, in the order the scenario emits them, with
 * the request ids an answer would have to be addressed to.
 *
 * Named here rather than derived from the scenario file so the test states the
 * SRD's vocabulary itself: a scenario silently losing a method would otherwise
 * shrink what is asserted without failing anything.
 */
const FIRE_AND_FORGET: ReadonlyArray<{ id: string; method: string }> = [
  { id: "uireq-notify", method: "notify" },
  { id: "uireq-setstatus", method: "setStatus" },
  { id: "uireq-setwidget", method: "setWidget" },
  { id: "uireq-settitle", method: "setTitle" },
  { id: "uireq-seteditortext", method: "set_editor_text" },
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
 */
const SUPERVISOR_COMMANDS = new Set([
  "get_state",
  "get_session_stats",
  "get_last_assistant_text",
  "prompt",
  "steer",
  "abort",
]);

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
  requestLog: string,
): Promise<{ pid: number; pgid: number }> {
  const res = await processLauncher.launchDetached({
    runId,
    runDir: join(root, runId),
    workerId: "eng-1",
    argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
    // The double inherits the supervisor's environment (it is spawned with no
    // `env` override), which is how the request log reaches it.
    env: {
      PIFLEET_PI_COMMAND: piCommand(scenario),
      PIFLEET_FAKE_REQUEST_LOG: requestLog,
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

function makeEnvelope(runId: string, taskId: string): TaskEnvelope {
  return TaskEnvelopeSchema.parse({
    schema: "pifleet.task/v1",
    task_id: taskId,
    run_id: runId,
    epoch: 0,
    attempt: 1,
    worker: "eng-1",
    dispatched_at: new Date().toISOString(),
    title: "ui request task",
    brief: "emit fire-and-forget UI requests mid-turn",
    repo: "unset",
    host_workdir: "unset",
    container_workdir: "/workspace",
    branch: `fleet/${runId}/eng-1`,
    base_ref: "0".repeat(40),
    outbox: `/outbox/${taskId}`,
    deadline_s: 300,
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

describe("extension_ui_request — fire-and-forget methods (ISC-113)", () => {
  test(
    "every fire-and-forget method is logged and none receives a response",
    async () => {
      const root = await freshRoot();
      const runId = testRunId("faf");
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      const requestLog = join(root, "fake-pi-requests.jsonl");
      const { pid } = await launchWorker(root, runId, "ui-fire-and-forget.json", requestLog);

      expect(
        await waitFor(async () => (await readWorkerState(wp))?.phase === "idle", 20_000),
      ).toBe(true);

      const reply = await controlCall(run, "eng-1", {
        cmd: "dispatch",
        envelope: makeEnvelope(runId, "T-UIREQ-1"),
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
          20_000,
        ),
      ).toBe(true);
      const record = await readTaskRecord(taskRecordPath(wp, "T-UIREQ-1"));
      expect(record?.verdict).toBe("success");
      expect(record?.reason).toBe("quiesced");

      // ---- Clause 1: "and are logged" -----------------------------------
      const events = await readJsonl(wp.eventsJsonl);
      const uiEvents = events
        .filter((e) => e["type"] === "event")
        .map((e) => e["event"] as Record<string, unknown> | undefined)
        .filter((e): e is Record<string, unknown> => e?.["type"] === "extension_ui_request");

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
      const ids = new Set(FIRE_AND_FORGET.map((m) => m.id));
      const addressed = sent.filter((m) =>
        JSON.stringify(m).includes("uireq-") || ids.has(String(m["id"])),
      );
      expect(
        addressed,
        `the supervisor addressed a fire-and-forget UI request: ${JSON.stringify(addressed)}`,
      ).toEqual([]);

      await controlCall(run, "eng-1", { cmd: "shutdown" }).catch(() => {});
      await waitFor(async () => (await processStartTime(pid)) === null, 5_000);
    },
    // One supervisor spawn plus its child double, no CLI spawns; measured
    // idle at ~1.4s. `cliBudget` is not used because nothing here runs the
    // CLI — the number matches the sibling supervisor-driven tests, which
    // carry a 20s readiness gate and a 20s settle gate inside the body.
    60_000,
  );
});
