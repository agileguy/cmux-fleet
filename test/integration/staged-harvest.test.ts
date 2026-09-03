/**
 * The harvest joins up for a staged dispatch (ISC-449, ISC-450).
 *
 * SRD-TUI-DISPATCH calls this "the whole point", and §1.3 item 3 is what it
 * closes: on the old `tui` route nothing wrote an inbox record, so
 * `dispatchedTaskIds` returned an empty set, `readResultEnvelope` had no
 * location to look in, and `unexplainedOutboxDirs` short-circuited before it
 * could name anything. A worker could do a day's work into its outbox and the
 * run would harvest as though the container had produced nothing.
 *
 * §6.5 claims the harvest needs **no change at all** to close that — the staged
 * route writes an inbox record and the existing machinery does the rest. This
 * file is that claim under test rather than taken on trust.
 *
 * ## What is real here and what is a double
 *
 * REAL: the dispatch path (`sendTaskEnvelope` → `planDispatch` → `sendViaPane`
 * → `stageForAdoptedTerminal`), the control socket and its auth, the inbox
 * write, the drop file, the ledger, and the whole harvest.
 *
 * A DOUBLE: only the supervisor's `stage` verb, which is a socket server that
 * answers with an epoch. It records every message it receives, which is what
 * makes "the route allocated through the supervisor rather than inventing a
 * number" an assertion rather than an assumption.
 *
 * NOT PRESENT AT ALL: any container, any pty, any terminal. ISC-455 is an
 * anti-criterion over this whole block and this is the file most likely to
 * have broken it.
 *
 * ## Two decisions that keep this honest
 *
 * **The allocated epoch is 7, not 1.** A worker's first task allocates 1, so a
 * fixture that uses 1 agrees with a hard-coded default by coincidence — which
 * is exactly how the old route's epoch gate passed for years by comparing 0
 * against 0, and exactly how the worker skill's "write 1" instruction survived.
 * Every epoch assertion below compares against the value the fake supervisor
 * returned, never against a literal.
 *
 * **`attach_process` points at the test process itself.** `terminalRefusal`
 * returns `null` only when the observed start time equals the recorded one, so
 * recording this process's own `(pid, started)` satisfies the terminal guard by
 * construction — with no process to spawn, and nothing to kill afterwards.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WorkerLaunchSchema } from "../../src/contracts.ts";
import { sendTaskEnvelope } from "../../src/cli/commands/dispatch.ts";
import { inboxTaskPath, runPaths, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import { LedgerWriter } from "../../src/run/ledger.ts";
import { processStartTime, serveJsonlSocket } from "../../src/run/registry.ts";
import { ensureControlAuth, loadControlSecret } from "../../src/security/control-auth.ts";
import { dispatchedTaskIds, unexplainedOutboxDirs } from "../../src/harvest/layout.ts";
import { harvestTask } from "../../src/harvest/index.ts";
import { splitDispatchPolicy } from "../../src/run/dispatch-policy.ts";
import { attemptIdFor } from "../../src/cli/commands/dispatch.ts";
import { cliBudget, opsBudget } from "../support/budget.ts";
import { renderPrompt } from "../../src/supervisor/index.ts";
import { mergeLedger } from "../../src/run/ledger.ts";
import { stat } from "node:fs/promises";

/**
 * `workerPaths().controlSock` hashes `(run_id, worker_id)` into the SHARED
 * `os.tmpdir()`, so two concurrent test processes with a fixed run id answer
 * each other's RPCs. Same idiom as `control-auth.test.ts`, and for the same
 * reason.
 */
const RUN_TAG = `${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const RUN_ID = `staged-harvest-${RUN_TAG}`;
const WORKER = "tui-1";
const TASK = "T-staged";
/** Deliberately not 1. See the header. */
const ALLOCATED = 7;

let tmp: string;
let runsDir: string;
let run: RunPaths;
let stageCalls: Record<string, unknown>[] = [];
const cleanups: Array<() => Promise<void>> = [];

function taskFile(taskId: string): string {
  return JSON.stringify({
    task_id: taskId,
    title: taskId,
    brief: "harvest join fixture",
    worker: WORKER,
  });
}

beforeAll(async () => {
  tmp = await mkdtemp(join(tmpdir(), "pifleet-staged-harvest-"));
  runsDir = join(tmp, "runs");
  run = runPaths(RUN_ID, runsDir);
  const wp = workerPaths(run, WORKER);

  await mkdir(run.inboxDir, { recursive: true });
  await mkdir(run.ledgerDir, { recursive: true });
  await mkdir(wp.dir, { recursive: true });
  await writeFile(join(run.root, "run.json"), JSON.stringify({ run_id: RUN_ID }));

  /**
   * The launch record must satisfy `launchPaneMode`'s AGREEMENT check — the
   * recorded `pane_mode` and the argv marks must not disagree, or
   * `planDispatch` returns `unavailable` and refuses to guess which control
   * plane this worker has. `-t` present, `--mode rpc` absent.
   */
  await writeFile(
    join(wp.dir, "launch.json"),
    JSON.stringify(
      WorkerLaunchSchema.parse({
        kind: "container",
        argv: ["docker", "run", "-i", "-t", "--rm", "--name", `pifleet-${RUN_ID}-${WORKER}`, "img", "pi"],
        container: `pifleet-${RUN_ID}-${WORKER}`,
        image: "img",
        pane_mode: "tui",
      }),
    ),
  );

  // The headless-with-adoption shape: the RUN opens no windows of its own, and
  // a person is nonetheless looking at a terminal that holds this worker.
  await writeFile(
    join(wp.dir, "presentation.json"),
    JSON.stringify({
      schema: "pifleet.presentation/v1",
      worker: WORKER,
      backend: "headless",
      adopted_terminal: true,
      surface_backend: null, // no addressable surface: the trigger is reported, not typed
      surface_ref: null,
      workspace_ref: null,
      window_ref: null,
      attach_process: {
        pid: process.pid,
        started: (await processStartTime(process.pid))!,
      },
    }),
  );

  const staged = new Set<string>();
  await ensureControlAuth(run);
  const secret = await loadControlSecret(run);
  const server = await serveJsonlSocket(
    wp.controlSock,
    async (msg) => {
      stageCalls.push(msg);
      if (msg["cmd"] === "stage") {
        /**
         * The double MODELS THE DEDUP rather than always answering fresh.
         *
         * Written flat (`replayed: false` always) first, and the ISC-440 probe
         * below caught it: a re-stage then looked like a new allocation, the
         * route correctly rewrote the drop, and the test failed for the double's
         * reason rather than the code's. A double that cannot produce the answer
         * the real allocator produces cannot test what the caller does with it.
         *
         * The key is `(task_id, attempt_id)`, which is `EpochManager`'s own.
         */
        const key = `${String(msg["attempt_id"])}\u0000${String(
          (msg["envelope"] as { task_id?: unknown } | undefined)?.task_id,
        )}`;
        const replayed = staged.has(key);
        staged.add(key);
        return { ok: true, accepted: true, epoch: ALLOCATED, replayed };
      }
      return { ok: false, error: `unexpected verb ${String(msg["cmd"])}` };
    },
    { secret },
  );
  cleanups.push(async () => server.stop());
  cleanups.push(() => rm(tmp, { recursive: true, force: true }));
  // The launch record's AGREEMENT check reaches one `ps` through
  // `processStartTime`. A `ps` is not a `git` and charging it as one would make
  // the count stop describing the body; the floor governs either way.
}, opsBudget({ probe: 1 }));

afterAll(async () => {
  for (const fn of cleanups.reverse()) await fn().catch(() => {});
});

/** Drive the real dispatch path once. */
async function stage(taskId: string): Promise<Awaited<ReturnType<typeof sendTaskEnvelope>>> {
  const raw = taskFile(taskId);
  const ledger = new LedgerWriter(run, `test-${process.pid}`);
  return sendTaskEnvelope({
    run,
    worker: WORKER,
    taskId,
    partial: JSON.parse(raw) as Record<string, unknown>,
    attemptId: attemptIdFor(raw),
    requestedEpoch: null,
    ledger,
  });
}

/** Stand in for the worker: write a result envelope into a named directory. */
async function workerWrites(dirName: string, taskId: string, epoch: number): Promise<void> {
  const dir = join(run.root, "outbox", WORKER, dirName);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "result.json"),
    JSON.stringify({
      schema: "pifleet.result/v1",
      task_id: taskId,
      epoch,
      worker: WORKER,
      status: "success",
      summary: "did the thing",
      files_changed: [],
      commits: [],
      commands_run: [],
      acceptance: [],
      artifacts: [],
      blockers: [],
      notes: "",
    }),
  );
}

describe("a staged dispatch is durable, and the harvest can see it (ISC-449)", () => {
  let outcome: Awaited<ReturnType<typeof sendTaskEnvelope>>;

  beforeAll(async () => {
    outcome = await stage(TASK);
    // `stage()` reaches the same single `ps` probe as the outer fixture.
  }, opsBudget({ probe: 1 }));

  /**
   * The trigger CANNOT be delivered here — there is no surface — and the
   * dispatch must still succeed. That is the design, not a tolerated failure:
   * six durable writes have already happened by the time the trigger is
   * attempted, and throwing would discard them to report a problem the
   * operator can fix by typing one line.
   */
  test("it resolves rather than throwing, and reports the staged route", () => {
    expect(outcome.accepted).toBe(true);
    expect(outcome.via).toBe("staged");
    expect(outcome.epoch).toBe(ALLOCATED);
  });

  test("the epoch came from the supervisor, not from the CLI", () => {
    const stages = stageCalls.filter((m) => m["cmd"] === "stage");
    expect(stages.length).toBeGreaterThanOrEqual(1);
    // …and it asked for an allocation rather than naming one.
    expect(stages[0]!["requested_epoch"]).toBeNull();
  });

  test("the inbox record exists and carries the allocated epoch", async () => {
    const rec = JSON.parse(await readFile(inboxTaskPath(run, TASK), "utf8")) as {
      task_id: string;
      epoch: number;
    };
    expect(rec.task_id).toBe(TASK);
    expect(rec.epoch).toBe(ALLOCATED);
    expect(rec.epoch).toBeGreaterThanOrEqual(1);
  });

  /**
   * The drop and the inbox record are the two sides `harvest/outbox.ts`
   * compares one step downstream. On the old route both were the placeholder 0
   * and the gate was satisfied by an accident; a disagreement here is the first
   * way this route can refuse a correct answer.
   */
  test("the drop file agrees with the inbox record about the epoch", async () => {
    const wp = workerPaths(run, WORKER);
    const { identity } = splitDispatchPolicy(await readFile(wp.dispatchPolicy, "utf8"));
    // `staged: false` is the CLEARED drop — the shape `materialize` writes
    // before anything is staged. A staged task whose drop reads cleared is the
    // failure this asserts against, so the discriminant is checked first.
    expect(identity.staged, "the drop was not written as a staged identity").toBe(true);
    if (identity.staged) expect(identity.epoch).toBe(ALLOCATED);
  });

  /**
   * ISC-435. The staged prompt must be what the RPC route would render for the
   * same envelope — byte for byte, not "equivalent".
   *
   * A route-specific abbreviation is the failure being excluded, and it is a
   * tempting one: this route writes to a file rather than typing, so a shorter
   * or restructured brief costs nothing to produce and would be invisible until
   * a worker behaved differently on one route than the other. `renderPrompt` is
   * called with the envelope read back off disk, so this compares the delivered
   * artefact against the shared renderer rather than against a copy of it.
   */
  test("the drop's prompt is byte-identical to what the rpc route renders", async () => {
    const wp = workerPaths(run, WORKER);
    const envelope = JSON.parse(await readFile(inboxTaskPath(run, TASK), "utf8")) as Parameters<
      typeof renderPrompt
    >[0];
    const { prompt } = splitDispatchPolicy(await readFile(wp.dispatchPolicy, "utf8"));
    expect(prompt).toBe(renderPrompt(envelope));
  });

  /**
   * ISC-439's fourth value. The inbox record, the drop and the CLI's answer are
   * asserted above; the ledger is the one an operator reads afterwards, and a
   * row that disagreed with the other three would make the audit trail the only
   * wrong copy — the worst place for the disagreement to be.
   */
  test("the ledger's dispatched row carries the same epoch", async () => {
    const { records } = await mergeLedger(run);
    const row = records.find((r) => r.event === "dispatched" && r.task_id === TASK);
    expect(row, "no dispatched row for the staged task").toBeDefined();
    expect(row!.epoch).toBe(ALLOCATED);
    expect((row!.detail as { via?: unknown } | undefined)?.via).toBe("staged");
  });

  /**
   * ISC-440. A re-stage of an UNCHANGED file replays, and the drop is NOT
   * rewritten.
   *
   * The second half is the one worth asserting. A replay that re-rendered the
   * drop would be a write performed on behalf of a stage that already happened,
   * and it is the write that could land while the epoch is mid-turn — replacing
   * the brief under a worker that is reading it. The inode is checked as well
   * as the mtime because the mount pins the inode: a rewrite that replaced the
   * file rather than truncating it would break the mount silently.
   *
   * The fake supervisor is what decides `replayed` here, so this proves the
   * CLI HONOURS a replay, not that the allocator produces one — that half is
   * `stage-verb.test.ts`'s, against a real `EpochManager`.
   */
  test("re-staging the same file replays and does not rewrite the drop", async () => {
    const wp = workerPaths(run, WORKER);
    const before = await stat(wp.dispatchPolicy);
    stageCalls = [];
    const again = await stage(TASK);
    expect(again.epoch).toBe(ALLOCATED);
    // The same attempt id reached the supervisor — the dedup key, not a new one.
    expect(stageCalls.find((m) => m["cmd"] === "stage")!["attempt_id"]).toBe(
      attemptIdFor(taskFile(TASK)),
    );
    const after = await stat(wp.dispatchPolicy);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  }, cliBudget(1));

  test("dispatchedTaskIds sees the task — the set is no longer empty", async () => {
    expect(await dispatchedTaskIds(run)).toContain(TASK);
  });

  /**
   * THE CRITERION. The worker writes where it was told to, and the harvest
   * accepts it — which on this route it has never been able to do.
   */
  test("a result written under the task id is harvested and claimed", async () => {
    await workerWrites(TASK, TASK, ALLOCATED);
    const t = await harvestTask(run, TASK, {});
    expect(t.harvest.task_id).toBe(TASK);
    expect(t.harvest.epoch).toBe(ALLOCATED);
    expect(t.harvest.claimed, "the envelope was refused, not accepted").not.toBeNull();
  }, cliBudget(1));

  /**
   * THE MUTATION, kept as a permanent test rather than run once. This is the
   * vacuously-passing check D6 replaced with a real one: a worker that writes
   * the epoch it thinks it has, rather than the one it was given, is refused.
   * The old `tui` route could not fail this because both sides were 0.
   */
  test("a result whose epoch disagrees is REFUSED, not accepted", async () => {
    const other = `${TASK}-mismatch`;
    await stage(other);
    // The worker writes 1 — the value the skill file used to instruct.
    await workerWrites(other, other, 1);
    const t = await harvestTask(run, other, {});
    expect(t.harvest.claimed, "a stale epoch was accepted").toBeNull();
    expect(JSON.stringify(t.harvest.discrepancies)).toContain("epoch");
  }, cliBudget(2));
});

describe("a misfiled result is NAMED rather than silently lost (ISC-450)", () => {
  const MISFILED = "list-tickets-2026-08-29";

  test("the finding names the directory", async () => {
    await workerWrites(MISFILED, TASK, ALLOCATED);
    const findings = await unexplainedOutboxDirs(run, WORKER);
    expect(findings.join("\n")).toContain(MISFILED);
    expect(findings.join("\n")).toContain("not a dispatched task id");
  });

  /**
   * THE CONTROL, and without it this proves only that the detector names
   * things. The correctly-named directory exists in the SAME outbox and must
   * produce no finding — a detector that named everything would pass the test
   * above and be useless.
   */
  test("the correctly-named directory produces no finding", async () => {
    const findings = await unexplainedOutboxDirs(run, WORKER);
    for (const f of findings) expect(f).not.toContain(`directory ${TASK}/`);
  });
});
