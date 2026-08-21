#!/usr/bin/env bun
/**
 * `pifleet-worker` — the detached supervisor (SRD §3.3–§3.4).
 *
 * One supervisor owns one Pi process, one RPC stream, one `state.json`. It is
 * a session leader detached from whatever launched it, because the CLI's or a
 * pane's lifetime must never be a worker's lifetime.
 *
 * The three container rules of §3.4, all implemented here:
 *   1. stdin stays open for the child's whole life — graceful stop is abort →
 *      settle → THEN close stdin. Closing early destroys in-flight responses.
 *   2. stderr is drained and mirrored into `events.jsonl` as `stderr_line`.
 *      An unread stderr pipe fills at ~64KB and the child blocks on write(2),
 *      presenting as a wedged agent with a green heartbeat.
 *   3. Death is detected by liveness, never exit code — Pi exits 0 on clean
 *      shutdown, broken pipe, and stdin EOF alike.
 *
 * Ordering guarantees the rest of the system leans on:
 *   - The fence snapshot and `state.json` are written durably BEFORE the
 *     prompt is sent (SRD §7.5): allocate-then-crash must not re-issue an
 *     epoch on restart.
 *   - `session_path` is recorded VERBATIM from `get_state` — never computed,
 *     never globbed (ISC-95) — and the absent→present transition is recorded
 *     so "never started" is distinguishable from "wrong path" (ISC-96).
 *   - Settlement requires the epoch window to be OPEN (an `agent_start`
 *     attributed to this epoch). A terminal event without a start — e.g. a
 *     straggler duplicate from a settled epoch — can never settle a task that
 *     never ran.
 *
 * In this phase the Pi process is the `pifleet-fake-pi` double, selected via
 * `PIFLEET_PI_COMMAND`; the docker invocation slots into the same seam later.
 */

import { existsSync } from "node:fs";
import { mkdir, unlink } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import {
  TaskEnvelopeSchema,
  type RpcEvent,
  type RpcResponse,
  type RpcSessionState,
  type Verdict,
  type WorkerState,
} from "../contracts.ts";
import { appendJsonl } from "../util/jsonl.ts";
import { RpcClient, RpcTimeoutError, Stopwatch } from "../rpc/client.ts";
import { CompletionTracker } from "../rpc/completion.ts";
import { EpochManager } from "../rpc/epoch.ts";
import { runPaths, taskRecordPath, workerPaths } from "../run/paths.ts";
import {
  initialWorkerState,
  readFence,
  readWorkerLaunch,
  writeFence,
  writeTaskRecord,
  writeWorkerState,
} from "../run/state.ts";
import { LedgerWriter } from "../run/ledger.ts";
import { processStartTime, registryCall, serveJsonlSocket } from "../run/registry.ts";
import { ensureControlAuth } from "../security/control-auth.ts";
import { pgidOf } from "./launch.ts";

/** Event types that end or could end a turn — logged when attributed prior. */
const TERMINAL_EVENT_TYPES = new Set(["agent_end", "auto_retry_end"]);

const HEARTBEAT_MS = 250;
const REPROBE_MS = 50;
const PROMPT_ACK_TIMEOUT_MS = 5_000;
const SHUTDOWN_GRACE_MS = 2_000;
/**
 * How long a deadline `abort` gets to produce a terminal event before the
 * supervisor settles the task itself and kills the child. `abort` is advisory
 * and a wedged agent may never honour it.
 */
const ABORT_GRACE_MS = 5_000;
/**
 * How long Pi gets to render its own transcript (ISC-234).
 *
 * Deliberately under the CLI's own ceiling — `CLI_EXPORT_HTML_TIMEOUT_MS` in
 * `src/cli/commands/transcript.ts`: whichever side gives up first, the operator
 * gets the local render rather than a hang, and losing the race HERE means the
 * supervisor is the one that says why.
 *
 * Exported because that ordering was load-bearing and enforced by nothing. A
 * comment cannot fail, and raising this number to 60s inverted the documented
 * relationship with the whole suite still green. `test/unit/export-html-race.
 * test.ts` now compares the two constants directly, so the flip is red before
 * any process is spawned.
 */
export const EXPORT_HTML_TIMEOUT_MS = 8_000;

/**
 * How long a Pi that ignored the export deadline gets to finish writing its
 * staging file before the supervisor deletes it.
 *
 * `export_html` has no cancel verb — Pi is told a path and renders to it, and
 * there is nothing to send that makes it stop. So the abandoned render is not
 * prevented, it is aimed somewhere harmless and then swept. The window is
 * generous because a file swept too early is a file swept while Pi is still
 * writing it, which achieves nothing; an orphan that outlives the sweep is one
 * stray `.pi-export-*.tmp` beside the operator's file, not a corrupted export.
 */
const EXPORT_SWEEP_MS = 30_000;

/**
 * Reap a staging render.
 *
 * `now: false` is the SUCCESS path: the file is real and the CLI is about to
 * claim it, so an immediate unlink would race the very rename it exists to
 * enable. Only the delayed pass runs, and it collects the file if the CLI died
 * before claiming it — an ENOENT once claimed, which is why every failure is
 * swallowed.
 *
 * `now: true` is the give-up path: nothing is coming for this file, so drop it
 * immediately and again after Pi's write could plausibly have landed.
 *
 * The timer is `unref`'d — this must never be the reason the supervisor
 * outlives its work.
 */
function sweepStagedExport(staging: string, opts: { now: boolean }): void {
  if (opts.now) void unlink(staging).catch(() => {});
  setTimeout(() => void unlink(staging).catch(() => {}), EXPORT_SWEEP_MS).unref();
}

interface Argv {
  runsRoot: string;
  runId: string;
  workerId: string;
}

function parseArgv(argv: string[]): Argv {
  let runsRoot = "";
  let runId = "";
  let workerId = "";
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--runs-root") runsRoot = argv[++i] ?? "";
    else if (a === "--run") runId = argv[++i] ?? "";
    else if (a === "--worker") workerId = argv[++i] ?? "";
  }
  if (runsRoot === "" || runId === "" || workerId === "") {
    process.stderr.write("usage: supervisor --runs-root <dir> --run <id> --worker <id>\n");
    process.exit(2);
  }
  return { runsRoot, runId, workerId };
}

async function main(): Promise<void> {
  const argv = parseArgv(process.argv.slice(2));
  const run = runPaths(argv.runId, argv.runsRoot);
  const wp = workerPaths(run, argv.workerId);
  await mkdir(wp.dir, { recursive: true });
  await mkdir(wp.tasksDir, { recursive: true });
  await mkdir(run.sessionsDir, { recursive: true });

  // The run's control secret (SRD §12.7), before ANY socket work: the control
  // server refuses requests without it, and registration with the daemon
  // sends it. `up` normally minted it already; the exclusive-create fallback
  // covers supervisors launched directly against a bare run directory.
  const controlAuth = await ensureControlAuth(run);

  const ledger = new LedgerWriter(run, argv.workerId);
  /**
   * The launch-time process group, RECORDED and never guessed (ISC-272).
   *
   * This read `(await pgidOf(process.pid)) ?? process.pid`, and the fallback
   * was the problem. `process.pid` is not a reading, it is the architectural
   * invariant restated — `launchDetached` spawns every supervisor `detached`,
   * so a supervisor IS its own group leader and `pgid === pid` (ISC-77/78) —
   * and recording it makes a FAILED capture indistinguishable on disk from a
   * successful one. That matters because `down` no longer takes this number on
   * trust: it confirms it against the OS and requires the identity-validated
   * process to LEAD the group. A guess that happens to be right would make the
   * launch record decorative, since every check it has to pass could then be
   * satisfied by the pid alone — the record would contribute nothing, and
   * "recorded when the supervisor launched" would be true of the field's name
   * only.
   *
   * `0` is the capture-failed sentinel, in the same spirit as `""` for
   * `started` on the next line, and it is a value the schema already permits
   * (`z.number().int().nonnegative()`) and every reader already handles:
   * `signalIfSame` refuses to address a non-positive group, `reaper.ts` maps
   * `entry.pgid > 0 ? entry.pgid : null` to "no group", and `down` reports
   * `group_unrecorded` and keeps the checkout rather than signalling. Nothing
   * on this path fabricates a group it did not measure.
   */
  const pgid = (await pgidOf(process.pid)) ?? 0;
  const started = (await processStartTime(process.pid)) ?? "";

  // Serialize events.jsonl appends so two async writes cannot interleave.
  let eventsChain: Promise<unknown> = Promise.resolve();
  const logEvent = (record: Record<string, unknown>): void => {
    /**
     * Stamped HERE, not inside the `.then` below.
     *
     * `ts` used to be evaluated when the queued append finally ran, which made
     * it the time the write was FLUSHED rather than the time the event
     * happened — and the gap between those is exactly the interval this log is
     * consulted about. A worker flooding a pipe queues thousands of
     * `stderr_line` appends ahead of whatever comes next, so under the load
     * that makes an event log worth reading, every timestamp in it drifted
     * later by however backed up the chain was. `settled` would claim to have
     * happened after a flood it actually preceded.
     *
     * Ordering is unaffected: the chain still serializes the writes, so the
     * file stays in emission order. Only the recorded time changes, from "when
     * the disk caught up" to "when this happened".
     */
    const ts = new Date().toISOString();
    eventsChain = eventsChain
      .then(() => appendJsonl(wp.eventsJsonl, { ts, ...record }))
      .catch(() => {});
  };

  /**
   * The launch record is read BEFORE state is assembled, not at the spawn.
   *
   * `state.container` has to be true from the FIRST state.json write. The
   * first flush happens well above the spawn, so setting the container down
   * at the branch left a real window in which state.json existed and said
   * `container: null` while a container was about to start — and a supervisor
   * killed inside that window leaves `down` with no name to remove, which is
   * precisely the orphan `--rm` cannot reap (it is a client-side action that
   * fires when the container EXITS, and the kill took the client). Reading
   * here costs one stat on a path that is usually absent.
   */
  const launch = await readWorkerLaunch(wp);

  // In-memory state, flushed atomically on every transition and heartbeat.
  const state: WorkerState = initialWorkerState({
    worker: argv.workerId,
    runId: argv.runId,
    pid: process.pid,
    pgid,
    startedAt: new Date().toISOString(),
    // The same value the `register_worker` call below carries. Recorded here
    // too because that call is `{ optional: true }` and a run with no daemon
    // must still be stoppable (ISC-191).
    procStarted: started,
    // Known from the record, so it is on disk before anything is spawned. The
    // container ID is deliberately not guessed: it is unknowable until Docker
    // starts it, and `down` removes by NAME.
    container:
      launch === null ? null : { name: launch.container, id: "", image: launch.image },
  });

  /**
   * ALL state.json writes go through one chain. `writeJsonAtomic` derives its
   * tmp name from (pid, millisecond); two concurrent writes to the same path
   * from one process can collide on that name, and the loser's rename throws
   * ENOENT after the winner consumed the tmp file. The integration suite
   * caught this as a supervisor crash mid-dispatch: an awaited fence write
   * racing a fire-and-forget one from the event path. Serializing per file is
   * the fix at this layer; the chain always writes the CURRENT state, so the
   * last write wins with the freshest data.
   */
  let stateChain: Promise<void> = Promise.resolve();
  const flushState = (): Promise<void> => {
    stateChain = stateChain
      .then(() => writeWorkerState(wp, state))
      .catch((err) => logEvent({ type: "state_write_failed", message: String(err) }));
    return stateChain;
  };

  await flushState();
  await ledger.append("worker_started", { worker: argv.workerId });

  // Register with the daemon when there is one. The supervisor must also work
  // alone (integration tests, daemon crash): registration is best-effort, and
  // identity is (pid, start-time) so pid reuse cannot resurrect us later.
  await registryCall(
    run,
    {
      cmd: "register_worker",
      entry: {
        worker: argv.workerId,
        pid: process.pid,
        pgid,
        started,
        registered_at: new Date().toISOString(),
      },
    },
    { optional: true },
  );

  // -------------------------------------------------------------------------
  // Spawn the Pi process (the double, in this phase).
  // -------------------------------------------------------------------------

  /**
   * Two launch paths, and the LAUNCH RECORD is what chooses between them.
   *
   * A container's argv is used VERBATIM; the double's is completed here. That
   * asymmetry is not a style choice, it is the whole reason this branch is
   * shaped this way. `buildPiArgv` already ends the rendered argv with
   * `--mode rpc --session-id <id> --session-dir /sessions` — CONTAINER paths,
   * because the run dir is bind-mounted at `/sessions` inside. The three lines
   * appended below spell the same flags with HOST paths, which is right for a
   * double running on this machine and wrong for a container.
   *
   * Appending them anyway would not throw. `pi` takes the LAST `--session-dir`,
   * so the container would write its sessions to a host path that does not
   * exist inside it, the supervisor would keep answering, tasks would keep
   * settling, and `harvest` would find nothing — a fleet that looks alive and
   * produces no transcripts. That is the quiet-wrongness this repo keeps
   * closing, so the container path adds NOTHING and says so.
   */
  let cmd: string[];
  if (launch !== null) {
    cmd = launch.argv;
  } else {
    const piCommand = process.env["PIFLEET_PI_COMMAND"];
    if (piCommand === undefined || piCommand.trim() === "") {
      state.phase = "dead";
      await flushState();
      process.stderr.write(
        "supervisor: no launch record and PIFLEET_PI_COMMAND is unset — nothing to run\n",
      );
      process.exit(3);
    }
    cmd = [
      ...piCommand.trim().split(/\s+/),
      "--mode",
      "rpc",
      "--session-dir",
      run.sessionsDir,
      "--session-id",
      argv.workerId,
    ];
  }

  const em = new EpochManager(await readFence(wp));
  const tracker = new CompletionTracker();
  const deadline = new Stopwatch();
  let deadlineMs: number | null = null;
  /** Pending kill ladder armed when a deadline `abort` goes unanswered. */
  let abortEscalation: ReturnType<typeof setTimeout> | null = null;
  let livePromptId: string | null = null;
  let probing = false;
  let shuttingDown = false;

  /**
   * Fence writes are serialized for the same tmp-name-collision reason as
   * state writes — but a fence write that FAILS is fail-stop: a supervisor
   * that cannot persist its high-water-mark durably must not keep allocating
   * epochs, or a crash re-issues one. The snapshot is captured at call time so
   * each queued write persists the fence as of the decision it records.
   */
  let fenceChain: Promise<void> = Promise.resolve();
  const persistFence = (): Promise<void> => {
    const snap = em.snapshot();
    fenceChain = fenceChain
      .then(() => writeFence(wp, argv.workerId, snap))
      .catch((err) => {
        logEvent({ type: "fence_write_failed", message: String(err) });
        void beginShutdown();
      });
    return fenceChain;
  };

  // A previous incarnation crashed mid-epoch: the epoch is burned and the task
  // fails — it may have partially run, and "maybe ran" must never look like
  // "never dispatched".
  if (em.live !== null) {
    const settled = em.settle("failed", new Date().toISOString());
    await persistFence();
    if (settled) {
      await writeTaskRecord(taskRecordPath(wp, settled.task_id), {
        schema: "pifleet.taskrecord/v1",
        task_id: settled.task_id,
        attempt_id: settled.attempt_id,
        worker: argv.workerId,
        run_id: argv.runId,
        epoch: settled.epoch,
        verdict: "failed",
        reason: "supervisor_restarted",
        settled_at: new Date().toISOString(),
      });
      state.completed_epochs = [...state.completed_epochs, settled.epoch];
    }
  }

  const child = Bun.spawn({
    cmd,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
    onExit(_proc, exitCode, signalCode) {
      void onChildExit(exitCode, signalCode === null ? null : String(signalCode));
    },
  });

  const settle = async (verdict: Verdict, reason: string): Promise<void> => {
    const settled = em.settle(verdict, new Date().toISOString());
    if (settled === null) return;
    probing = false;
    livePromptId = null;
    deadlineMs = null;
    // Disarm the kill ladder: the epoch is over. Leaving it armed would keep
    // the event loop alive and, worse, let a timer from a settled epoch fire
    // against whatever epoch is live by then.
    if (abortEscalation !== null) {
      clearTimeout(abortEscalation);
      abortEscalation = null;
    }
    tracker.reset();
    await persistFence();
    await writeTaskRecord(taskRecordPath(wp, settled.task_id), {
      schema: "pifleet.taskrecord/v1",
      task_id: settled.task_id,
      attempt_id: settled.attempt_id,
      worker: argv.workerId,
      run_id: argv.runId,
      epoch: settled.epoch,
      verdict,
      reason,
      settled_at: new Date().toISOString(),
    });
    state.phase = shuttingDown ? state.phase : "idle";
    state.task_id = null;
    state.completed_epochs = [...state.completed_epochs, settled.epoch];
    await flushState();
    await ledger.append("settled", {
      worker: argv.workerId,
      task_id: settled.task_id,
      epoch: settled.epoch,
      detail: { verdict, reason },
    });
    logEvent({ type: "settled", task_id: settled.task_id, epoch: settled.epoch, verdict, reason });
  };

  async function onChildExit(code: number | null, signal: string | null): Promise<void> {
    state.exit = { code, signal };
    state.phase = "dead";
    client.close("child exited");
    if (em.live !== null) {
      // Death is a fact about the worker, not the task — but a task in flight
      // when the worker died cannot be trusted to have finished (SRD §3.4).
      await settle("failed", "worker_died");
      state.phase = "dead";
    }
    await flushState();
    await ledger.append("worker_exit", {
      worker: argv.workerId,
      detail: { code, signal },
    });
    if (shuttingDown) {
      await registryCall(run, { cmd: "deregister_worker", worker: argv.workerId }, { optional: true });
      await server.stop();
      clearInterval(heartbeat);
      process.exit(0);
    }
  }

  // -------------------------------------------------------------------------
  // Completion probing: conditions 1–3 via the tracker, condition 4 via a
  // DOUBLE correlated get_state under one generation token.
  // -------------------------------------------------------------------------

  const maybeProbe = (): void => {
    if (probing || shuttingDown) return;
    if (!em.windowOpen || !tracker.eligible) return;
    probing = true;
    void (async () => {
      const token = tracker.beginProbe();
      try {
        const r1 = await client.send("get_state");
        const r2 = await client.send("get_state");
        const s1 = (r1.response.data ?? {}) as RpcSessionState;
        const s2 = (r2.response.data ?? {}) as RpcSessionState;
        recordSessionPath(s1);
        if (r1.response.success && r2.response.success && tracker.confirm(token, s1, s2)) {
          const verdict: Verdict = em.timedOut
            ? "timed_out"
            : em.abortRequested
              ? "aborted"
              : "success";
          await settle(verdict, "quiesced");
          return;
        }
      } catch {
        // Client closed or timed out; the exit path owns the consequences.
      }
      probing = false;
      // Conditions may still hold with no further event to re-trigger us.
      setTimeout(maybeProbe, REPROBE_MS);
    })();
  };

  const recordSessionPath = (s: RpcSessionState): void => {
    const file = typeof s.sessionFile === "string" ? s.sessionFile : null;
    if (file !== null && state.session_path !== file) {
      // Verbatim, never computed, never globbed (ISC-95).
      state.session_path = file;
      state.session_present = existsSync(file);
    }
  };

  // -------------------------------------------------------------------------
  // Event handling — stream-seq attribution first, everything else second.
  // -------------------------------------------------------------------------

  const onEvent = (event: RpcEvent, seq: number): void => {
    state.last_event = event.type;
    state.last_event_at = new Date().toISOString();
    switch (event.type) {
      case "turn_end":
        state.turns++;
        break;
      case "tool_execution_end":
        state.tool_calls++;
        if ((event as { isError?: unknown }).isError === true) state.tool_errors++;
        break;
      case "compaction_end":
        state.compactions++;
        break;
      case "auto_retry_start":
        state.retries++;
        break;
      default:
        break;
    }
    logEvent({ type: "event", seq, event });

    if (event.type === "agent_start" && em.live !== null && !em.windowOpen) {
      if (em.bindStart(seq)) {
        tracker.reset();
        tracker.observe(event);
        void persistFence();
        logEvent({ type: "epoch_started", epoch: em.live.epoch, seq });
        return;
      }
      // An agent_start at or below the ack seq: some prior epoch's, not ours.
      logEvent({ type: "epoch_attribution", attributed: "prior", seq, event_type: event.type });
      return;
    }

    const attribution = em.attribute(seq);
    if (attribution === "live" && em.windowOpen) {
      tracker.observe(event);
      maybeProbe();
      return;
    }

    // Attributed to a prior (settled) epoch — recorded, never counted toward
    // the live epoch's completion, never blindly discarded (SRD §7.5 fix).
    if (TERMINAL_EVENT_TYPES.has(event.type)) {
      logEvent({ type: "epoch_attribution", attributed: "prior", seq, event_type: event.type });
      void ledger.append("prior_epoch_event", {
        worker: argv.workerId,
        detail: { seq, event_type: event.type },
      });
    }
  };

  const onStray = (response: RpcResponse, seq: number, kind: "late" | "unknown"): void => {
    logEvent({ type: "stray_response", kind, seq, id: response.id ?? null, success: response.success });
    // ISC-86: a late success:false on the live epoch's prompt fails that epoch.
    if (
      kind === "late" &&
      response.success === false &&
      em.live !== null &&
      response.id !== undefined &&
      response.id === livePromptId
    ) {
      // Same hazard as the deadline escalation: an unguarded `void settle(...)`
      // turns a durable-write failure into an unhandled rejection that exits
      // the supervisor.
      void settle("failed", `late_prompt_failure: ${response.error ?? "unknown"}`).catch(
        (err: unknown) => {
          logEvent({ type: "settle_failed", reason: String(err) });
        },
      );
    }
  };

  const client = new RpcClient(
    {
      write: (s) => child.stdin.write(s),
      flush: () => child.stdin.flush(),
    },
    {
      onEvent,
      onStray,
      onProtocolError: (err) => {
        logEvent({ type: "protocol_error", message: err.message });
        // The stream is unusable; only liveness detection remains. Kill the
        // child so death is unambiguous rather than a half-open pipe.
        child.kill();
      },
      idPrefix: argv.workerId,
    },
  );

  void (async () => {
    for await (const chunk of child.stdout) client.feed(chunk as Uint8Array);
    client.feedEof();
  })();

  // Rule 2: drain stderr, mirror into events.jsonl.
  void (async () => {
    const decoder = new TextDecoder();
    let buffer = "";
    for await (const chunk of child.stderr) {
      buffer += decoder.decode(chunk as Uint8Array, { stream: true });
      for (;;) {
        const nl = buffer.indexOf("\n");
        if (nl === -1) break;
        logEvent({ type: "stderr_line", line: buffer.slice(0, nl) });
        buffer = buffer.slice(nl + 1);
      }
    }
    if (buffer.length > 0) logEvent({ type: "stderr_line", line: buffer });
  })();

  // -------------------------------------------------------------------------
  // Control socket — started BEFORE the phase can ever read `idle`. "Idle"
  // means "dispatchable"; a state file that says idle while the socket is not
  // yet listening sends the first dispatch into a stale socket file left by a
  // SIGKILLed predecessor (found by the ISC-75/76 integration test).
  // -------------------------------------------------------------------------

  const server = await startControlServer();

  // Initial get_state: records the session path verbatim and proves the RPC
  // stream is live — the idle gate ISC-70 measures.
  try {
    const r = await client.send("get_state", {}, { timeoutMs: 30_000 });
    if (r.response.success) recordSessionPath((r.response.data ?? {}) as RpcSessionState);
    state.phase = "idle";
  } catch {
    state.phase = "dead";
  }
  await flushState();

  // -------------------------------------------------------------------------
  // Heartbeat: liveness, session-file transition, monotonic deadline.
  // -------------------------------------------------------------------------

  const heartbeat = setInterval(() => {
    state.heartbeat_at = new Date().toISOString();
    if (state.session_path !== null && !state.session_present && existsSync(state.session_path)) {
      // The absent→present transition (ISC-96), recorded the moment it happens.
      state.session_present = true;
      logEvent({ type: "session_file_present", path: state.session_path });
    }
    if (deadlineMs !== null && em.live !== null && deadline.elapsedMs() > deadlineMs) {
      deadlineMs = null;
      em.noteTimedOut();
      em.noteAbortRequested();
      void persistFence();
      logEvent({ type: "deadline_exceeded", task_id: em.live.task_id, epoch: em.live.epoch });
      void client.send("abort").catch(() => {});
      // `abort` is advisory: an agent blocked inside a tool call may never act
      // on it, and settle is reachable only through `agent_end`. Without a
      // terminal escalation the epoch stays live forever — and because
      // `allocate` refuses while an epoch is live, that strands the whole
      // worker, not just this task. Arm the same kill ladder shutdown uses.
      abortEscalation = setTimeout(() => {
        abortEscalation = null;
        if (em.live === null) return; // the abort landed; nothing to escalate.
        logEvent({ type: "deadline_escalated", epoch: em.live.epoch });
        // `.catch` BEFORE `.finally`, and not the other way round. `settle()`
        // awaits writeTaskRecord and ledger.append, neither guarded; on ENOSPC
        // or EROFS it rejects, and a bare `void p.finally(...)` re-raises that
        // as an unhandled rejection which takes the whole supervisor down —
        // killing the child with no worker_exit row, no deregistration, and
        // state.json frozen mid-transition, leaving the run unreapable. The
        // kill must still happen, which is why it stays in `finally`.
        void settle("timed_out", "deadline_exceeded_no_terminal_event")
          .catch((err: unknown) => {
            logEvent({ type: "settle_failed", reason: String(err) });
          })
          .finally(() => {
            // Death must be unambiguous: a child that ignored abort is not
            // trustworthy to run the next task.
            child.kill();
          });
      }, ABORT_GRACE_MS);
    }
    void flushState();
  }, HEARTBEAT_MS);

  // -------------------------------------------------------------------------
  // Control socket handler (started earlier, before idle was writable).
  // -------------------------------------------------------------------------

  async function startControlServer(): ReturnType<typeof serveJsonlSocket> {
    return serveJsonlSocket(wp.controlSock, async (msg) => {
    switch (msg["cmd"]) {
      case "ping":
        return { ok: true, worker: argv.workerId, pid: process.pid };

      case "status":
        return { ok: true, state };

      case "dispatch": {
        const envelope = TaskEnvelopeSchema.parse(msg["envelope"]);
        const attemptId = typeof msg["attempt_id"] === "string" ? msg["attempt_id"] : "a-unknown";
        const requested = typeof msg["requested_epoch"] === "number" ? msg["requested_epoch"] : null;

        const decision = em.allocate(envelope.task_id, attemptId, requested);
        if (!decision.ok) {
          await ledger.append("dispatch_rejected", {
            worker: argv.workerId,
            task_id: envelope.task_id,
            detail: { reason: decision.reason },
          });
          return { accepted: false, ...decision };
        }
        if (decision.replayed) {
          // Idempotent retry: the original answer, verbatim — the caller lost
          // the ack, not the dispatch.
          return { accepted: true, epoch: decision.epoch, replayed: true };
        }

        // Durable fence BEFORE the prompt; state.json epoch BEFORE the prompt
        // (SRD §7.5). Crash between here and the send burns the epoch — safe.
        await persistFence();
        state.epoch = decision.epoch;
        state.task_id = envelope.task_id;
        state.phase = "busy";
        await flushState();
        deadline.restart();
        deadlineMs = envelope.deadline_s * 1000;

        const message = renderPrompt(envelope);
        try {
          const sent = await client.send(
            "prompt",
            { message, streamingBehavior: "followUp", epoch: decision.epoch },
            {
              timeoutMs: PROMPT_ACK_TIMEOUT_MS,
              // The fence post must be set the instant the ack is parsed, not
              // when this await resumes. Pi may emit the ack and `agent_start`
              // in one write; handling is synchronous within a chunk, so an
              // ack recorded a microtask later leaves `ack_seq` null for that
              // `agent_start`, which is then filed as a prior epoch's. The
              // window never opens and every subsequent event — `agent_end`
              // included — is discarded, hanging the task and the worker.
              onAck: (seq) => em.noteAck(seq),
            },
          );
          if (!sent.response.success) {
            await settle("failed", `prompt_rejected: ${sent.response.error ?? "unknown"}`);
            return { accepted: false, reason: "prompt_rejected", error: sent.response.error ?? null };
          }
          livePromptId = sent.response.id ?? null;
          // Belt and braces: onAck has already recorded this exact seq, and
          // noteAck is first-write-wins per epoch, so this is a no-op on the
          // normal path and the fallback if the hook is ever bypassed.
          em.noteAck(sent.seq);
          await persistFence();
        } catch (err) {
          if (err instanceof RpcTimeoutError) {
            // The ack may still arrive; keep the id so a late failure can be
            // attributed. The epoch stays live until liveness says otherwise.
            livePromptId = err.id;
          } else {
            await settle("failed", `prompt_send_failed: ${String(err)}`);
            return { accepted: false, reason: "prompt_send_failed" };
          }
        }
        await ledger.append("dispatch_accepted", {
          worker: argv.workerId,
          task_id: envelope.task_id,
          epoch: decision.epoch,
        });
        return { accepted: true, epoch: decision.epoch, replayed: false };
      }

      case "steer": {
        if (em.live === null) return { ok: false, error: "no live epoch" };
        const message = typeof msg["message"] === "string" ? msg["message"] : "";
        const sent = await client.send("steer", { message });
        return { ok: sent.response.success };
      }

      /**
       * A5 (SRD §8.4, ISC-101/ISC-234): Pi exports its OWN session.
       *
       * The CLI can always re-render A4 itself, and does — that fallback is
       * what makes ISC-101 hold for the dead workers harvest exists for. But
       * a re-render is a SECOND opinion about a file Pi wrote: it knows only
       * the record types `harvest/transcript.ts` models, and silently flattens
       * everything else. While a worker is alive, its own renderer is the
       * authority, and the only way to reach it is through here — a control
       * socket that answered `unknown cmd: export_html` made the live path
       * unreachable and left every export, live or dead, on the fallback.
       *
       * PI IS NEVER TOLD THE OPERATOR'S PATH, and neither is this process the
       * one that writes it. Pi renders into a unique staging sibling; the
       * supervisor reports where; the CLI renames it into place. Exactly ONE
       * process ever names the operator's file, and it is the process that told
       * the operator what the file is.
       *
       * That is not tidiness, it is the whole correctness argument, because Pi
       * writes the file itself and the deadline below is advisory — there is no
       * verb that cancels an export already in flight:
       *
       *   t=8s   the send times out; the supervisor answers `ok:false`
       *   t=8s   the CLI falls back, writes its OWN render, prints `source:
       *          "local"`, exits 0
       *   t=13s  Pi finishes
       *
       * With the path forwarded verbatim, that last line overwrote the file the
       * operator had just been told was the CLI's second opinion — the exact
       * provenance question ISC-234 exists to answer, delivered inverted, and
       * torn down the middle if the two writes interleaved.
       *
       * Renaming HERE, on confirmed success, would still leave a window: Pi
       * confirming at 7.9s and this rename landing after the CLI's own ceiling
       * has expired puts the agent's bytes at the operator's path AFTER the CLI
       * has already written and reported `"local"`. Same inversion, smaller
       * window. Handing the staging path back instead removes the second writer
       * rather than making it faster, so there is no window left to size.
       *
       * The orphan a lost race leaves is swept by `sweepStagedExport`. A path
       * Pi resolves inside a container namespace produces no file at the host
       * staging path, the CLI's rename fails ENOENT, and the export degrades to
       * the local render instead of reporting a success that wrote nothing.
       */
      case "export_html": {
        const path = msg["path"];
        if (typeof path !== "string" || path === "") {
          return { ok: false, error: "export_html requires a non-empty path" };
        }
        // A sibling, so the CLI's rename is same-directory and therefore atomic
        // and never cross-device.
        const staging = `${path}.pi-export-${randomUUID()}.tmp`;
        try {
          const sent = await client.send(
            "export_html",
            { path: staging },
            { timeoutMs: EXPORT_HTML_TIMEOUT_MS },
          );
          if (!sent.response.success) {
            sweepStagedExport(staging, { now: true });
            return { ok: false, error: sent.response.error ?? "export_html failed" };
          }
          // Offer only what Pi confirmed it finished. The delayed sweep is the
          // backstop for a CLI that dies before claiming it.
          sweepStagedExport(staging, { now: false });
          return { ok: true, staged: staging, error: null };
        } catch (err) {
          // A wedged or dead child must not take the supervisor down, and the
          // caller has a working fallback — report the failure and keep serving.
          sweepStagedExport(staging, { now: true });
          return { ok: false, error: `export_html: ${String(err)}` };
        }
      }

      case "abort": {
        if (em.live === null) return { ok: false, error: "no live epoch" };
        em.noteAbortRequested();
        await persistFence();
        await ledger.append("abort_requested", {
          worker: argv.workerId,
          task_id: em.live?.task_id ?? undefined,
        });
        void client.send("abort").catch(() => {});
        return { ok: true };
      }

      case "shutdown": {
        void beginShutdown();
        return { ok: true };
      }

      default:
        return { ok: false, error: `unknown cmd: ${String(msg["cmd"])}` };
    }
    }, { secret: controlAuth.secret });
  }

  async function beginShutdown(): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    // Graceful stop per §13 F3: abort → give the turn a moment to settle →
    // THEN close stdin. Closing stdin first destroys in-flight responses.
    if (em.live !== null) {
      void client.send("abort").catch(() => {});
      const grace = new Stopwatch();
      while (em.live !== null && grace.elapsedMs() < SHUTDOWN_GRACE_MS) {
        await new Promise((r) => setTimeout(r, 25));
      }
      if (em.live !== null) await settle("aborted", "shutdown");
    }
    try {
      child.stdin.end();
    } catch {
      // Already gone.
    }
    // onChildExit finishes the job (state, deregistration, exit). If the child
    // never exits, force it after the grace period.
    setTimeout(() => child.kill(), SHUTDOWN_GRACE_MS);
  }

  process.on("SIGTERM", () => void beginShutdown());
  process.on("SIGINT", () => void beginShutdown());
}

function renderPrompt(envelope: { title: string; brief: string; acceptance: string[] }): string {
  const acceptance =
    envelope.acceptance.length > 0
      ? `\n\n## Acceptance\n${envelope.acceptance.map((a) => `- ${a}`).join("\n")}`
      : "";
  return `# ${envelope.title}\n\n${envelope.brief}${acceptance}`;
}

if (import.meta.main) {
  await main();
}
