/**
 * The event log's scrubber is actually WIRED, and the log is owner-only.
 *
 * ## Why this file drives a supervisor instead of calling the scrubber
 *
 * `test/unit/redact.test.ts` proves `buildRedactor` is correct. A correct
 * scrubber that nothing calls is indistinguishable at runtime from one that
 * was never written, and its green unit suite is exactly what would make it
 * look done — the shape `harvest/index.ts` records about the adjudicator that
 * had "a full passing test suite and ZERO production callers", and the reason
 * `harvest-reconcile-wiring.test.ts` exists.
 *
 * So THIS file never imports `src/security/redact.ts`. It starts a real
 * detached supervisor over a real Pi double, hands it a real 0600 env file,
 * makes the double echo the credential the way the worker that caused all this
 * did, and then reads the bytes on disk. Deleting the `transform` argument in
 * `supervisor/index.ts` leaves every unit test green and turns this red, which
 * is the split that makes the wiring checkable rather than assumed.
 *
 * ## The canary is synthetic and that is load-bearing
 *
 * `CANARY` is a made-up 41-character string — the length of the token that
 * leaked on 2026-08-28, so the min-length guard is exercised at a realistic
 * size — and it exists only in this file and in the temp directory a run
 * builds from it. Nothing here reads a real environment variable, so this
 * suite cannot leak an operator's credential into a CI log even when it fails.
 *
 * ## The control comes first
 *
 * A fixture whose double never emits the canary, or whose supervisor never
 * read the env file, passes "the log does not contain it" for the one reason
 * that proves nothing. Two assertions guard that: `redaction_armed` must name
 * the variable, and the marker must be PRESENT in the log. An absent secret
 * with no marker beside it means the fixture missed, not that the control
 * worked.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { TaskEnvelopeSchema, type TaskEnvelope } from "../../src/contracts.ts";
import { runPaths, taskRecordPath, workerPaths } from "../../src/run/paths.ts";
import { readTaskRecord, readWorkerState } from "../../src/run/state.ts";
import { controlCall, processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";
import { cliBudget } from "../support/budget.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");

/**
 * A synthetic credential. NOT a real token and never was one — 41 characters
 * because that is what leaked, so the needle here is the size of a real one.
 */
const CANARY = "NOTAREALSECRET-pifleet-test-canary-000001";

/** The variable through which `up` tells a supervisor which names are secret. */
const SECRET_NAMES_WIRE = "PIFLEET_SECRET_NAMES";
const SECRET_VAR = "TICKET_API_TOKEN";
const MARKER = `[redacted:${SECRET_VAR}]`;

const WORKER = "tick-1";
const TASK = "T-REDACT-1";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  if (process.env["PIFLEET_INT_KEEP"] === "1") return;
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

const RUN_TAG = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;

async function waitFor(cond: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    if (await cond()) return true;
    if (performance.now() - start > budgetMs) return false;
    await Bun.sleep(50);
  }
}

function envelope(runId: string): TaskEnvelope {
  return TaskEnvelopeSchema.parse({
    schema: "pifleet.task/v1",
    task_id: TASK,
    run_id: runId,
    epoch: 0,
    attempt: 1,
    worker: WORKER,
    dispatched_at: new Date().toISOString(),
    title: "echo the credential",
    brief: "the worker was told twice not to do this",
    repo: "unset",
    host_workdir: "unset",
    container_workdir: "/workspace",
    branch: `fleet/${runId}/${WORKER}`,
    base_ref: "0".repeat(40),
    outbox: `/outbox/${TASK}`,
    deadline_s: 300,
  });
}

/**
 * A scenario in which the double puts the credential in all three of the
 * fields the real leak was found in.
 *
 * Written at runtime rather than checked in: the canary would otherwise be a
 * token-shaped string in a committed fixture, which is the thing this whole
 * criterion is about not doing. The three shapes are copied verbatim from the
 * 2026-08-28 incident — `tool_execution_update.partialResult.content[0].text`,
 * `tool_execution_end.result.content[0].text` and
 * `message_start.message.content[0].text` — so a scrubber that walked known
 * fields instead of the serialised line would still pass this file. That is
 * fine and deliberate: this file proves WIRING, and `redact.test.ts` proves
 * the walker-versus-text choice.
 */
function scenario(): string {
  const text = (s: string): Record<string, unknown> => ({
    content: [{ type: "text", text: s }],
  });
  return JSON.stringify({
    scenario: "echoes-its-credential",
    steps: [
      {
        on: "prompt",
        emit: [
          { type: "agent_start" },
          { type: "turn_start" },
          { type: "tool_execution_start", tool: "bash" },
          {
            type: "tool_execution_update",
            tool: "bash",
            partialResult: text(`$ echo $${SECRET_VAR}\n${CANARY}`),
          },
          {
            type: "tool_execution_end",
            tool: "bash",
            isError: false,
            result: text(CANARY.slice(0, 20)),
          },
          {
            type: "message_start",
            message: { role: "assistant", ...text(`the token is ${CANARY}`) },
          },
          { type: "turn_end" },
          { type: "agent_end", messages: [], willRetry: false },
          { type: "queue_update", steering: [], followUp: [] },
        ],
      },
    ],
  });
}

interface Live {
  root: string;
  runId: string;
  eventsPath: string;
  sessionsDir: string;
}

/**
 * Stand a run up by hand and start a supervisor over it.
 *
 * By hand rather than through `pifleet up` because `up` would read the
 * operator's own `fleet.yaml` and their real environment to find a value for
 * `secrets:`. This test must never touch a real credential, so it writes the
 * env file itself in the format `serializeEnvFile` produces — which is also
 * what makes the WIRE FORMAT part of what is pinned here: a supervisor that
 * stopped reading `PIFLEET_SECRET_NAMES` from the env file goes red.
 */
async function live(tag: string): Promise<Live> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-redact-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const runId = `int-redact-${tag}-${RUN_TAG}`;
  const run = runPaths(runId, root);
  const wp = workerPaths(run, WORKER);

  await mkdir(wp.dir, { recursive: true });
  await mkdir(run.sessionsDir, { recursive: true, mode: 0o700 });
  await mkdir(run.inboxDir, { recursive: true });

  await writeFile(
    wp.envFile,
    `PIFLEET_LLM_PROVIDER=omlx\n${SECRET_NAMES_WIRE}=${SECRET_VAR}\n${SECRET_VAR}=${CANARY}\n`,
    { mode: 0o600 },
  );

  const scenarioPath = join(root, "echoes-its-credential.json");
  await writeFile(scenarioPath, scenario());

  const { pid, pgid } = await processLauncher.launchDetached({
    runId,
    runDir: run.root,
    workerId: WORKER,
    argv: supervisorArgv({ runsRoot: root, runId, workerId: WORKER }),
    env: { PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${scenarioPath}` },
    logPath: wp.supervisorLog,
  });
  cleanups.push(async () => {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      try {
        process.kill(pid, "SIGKILL");
      } catch {
        // already gone
      }
    }
  });

  const idle = await waitFor(async () => {
    const s = await readWorkerState(wp).catch(() => null);
    return s !== null && (s.phase === "idle" || s.phase === "busy");
  }, 10_000);
  expect(idle).toBe(true);

  const reply = await controlCall(run, WORKER, {
    cmd: "dispatch",
    envelope: envelope(runId),
    attempt_id: `redact-${tag}`,
    requested_epoch: null,
  });
  expect(reply["accepted"]).toBe(true);

  const settled = await waitFor(
    async () => (await readTaskRecord(taskRecordPath(wp, TASK))) !== null,
    15_000,
  );
  expect(settled).toBe(true);

  await controlCall(run, WORKER, { cmd: "shutdown" }).catch(() => {});
  return { root, runId, eventsPath: wp.eventsJsonl, sessionsDir: run.sessionsDir };
}

describe("a worker that echoes its credential does not put it in events.jsonl (ISC-336)", () => {
  test(
    "the value is absent, the marker is present, and the log is still parseable JSONL",
    async () => {
      const l = await live("a");
      const text = await readFile(l.eventsPath, "utf8");
      const lines = text.split("\n").filter((s) => s.trim() !== "");

      // CONTROL 1 — the supervisor really did arm from the env file. Without
      // this, "no canary in the log" could just mean nothing was ever read.
      const armed = lines
        .map((s) => JSON.parse(s) as Record<string, unknown>)
        .find((r) => r["type"] === "redaction_armed");
      expect(armed).toBeDefined();
      expect(armed?.["source"]).toBe("env-file");
      expect(armed?.["armed"]).toEqual([SECRET_VAR]);

      // CONTROL 2 — the double really did emit it, and a match really fired.
      // An absent secret with no marker beside it is a fixture that missed.
      expect(text).toContain(MARKER);

      // THE CRITERION.
      expect(text).not.toContain(CANARY);
      // The 20-character prefix `head -c 20` would have printed is a substring
      // of the canary, so a scrubber that only matched whole values would
      // leave it: assert on the prefix separately rather than trusting that
      // the full-value check covers it.
      expect(text).not.toContain(CANARY.slice(0, 20));

      // Scrubbing rewrote JSON text, so prove it did not corrupt it.
      for (const line of lines) expect(() => JSON.parse(line)).not.toThrow();
    },
    cliBudget(45),
  );
});

describe("the event log and the sessions directory are owner-only (ISC-335)", () => {
  test(
    "events.jsonl is 0600 and sessions/ is 0700 on a run with no container",
    async () => {
      const l = await live("b");
      expect(statSync(l.eventsPath).mode & 0o777).toBe(0o600);
      expect(statSync(l.sessionsDir).mode & 0o777).toBe(0o700);
    },
    cliBudget(45),
  );
});
