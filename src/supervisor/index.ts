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
import { join } from "node:path";
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
import { isInsideRunTree, runPaths, taskRecordPath, workerPaths } from "../run/paths.ts";
import {
  initialWorkerState,
  readFence,
  readRunProseTurnsBeforeFail,
  readRunUiRequestTimeoutMs,
  readWorkerLaunch,
  writeFence,
  writeTaskRecord,
  writeWorkerState,
} from "../run/state.ts";
import { LedgerWriter } from "../run/ledger.ts";
import { worktreeContentHash } from "../run/treehash.ts";
import { processStartTime, registryCall, serveJsonlSocket } from "../run/registry.ts";
import { ensureControlAuth } from "../security/control-auth.ts";
import { redactorForWorkerEnv } from "../security/redact.ts";
import { gcloudMinter, injectToken, resolveIdentity } from "../security/adc.ts";
import { TokenRefresher, type RefreshFailure } from "../security/refresh.ts";
import { realExec } from "../container/run.ts";
import type { CredentialInjection } from "../contracts.ts";
import { processGroupId } from "../safety/procgroup.ts";
import {
  NO_TOOL_CALLS_REASON,
  NO_WORK_DONE_REASON,
  ProseTurnDetector,
} from "./prose-detector.ts";
import { cancelledResponse, classifyUiRequest } from "./ui-requests.ts";

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
   *
   * READ THROUGH `processGroupId`, which is the same function `down`'s
   * `confirmGroup` uses to vouch for what this line writes. It was `pgidOf`, a
   * second `ps -o pgid=` implementation in `launch.ts` that ignored stderr and
   * never looked at the exit status — so a `ps` killed by memory pressure and
   * a `ps` that printed a group were both "a number or null" to the writer,
   * while the reader had already been fixed to keep those apart. `.catch` maps
   * a refused read to the SAME `0` a `null` produces: this process cannot act
   * on the distinction, it can only record that it did not measure.
   *
   * `process.pid`, not a pid handed in — so unlike `launchDetached` there is no
   * reissue window to close here. A process asking the OS about itself cannot
   * be told about a stranger.
   *
   * BOTH LINES CATCH, and the second one did not until 2026-08-26. The
   * paragraph above described the pair as degrading together to values "every
   * reader already handles" — and `started` did no such thing. Since ISC-192
   * `processStartTime` THROWS on a read it cannot trust rather than reporting
   * absence, `?? ""` never sees the failure, and `main` is awaited at top
   * level with no catch. Measured, not reasoned: a `ps` on PATH that exits 1
   * with a diagnostic killed the supervisor outright —
   *
   *     IdentityReadError: could not read the start time of pid 92280:
   *     ps: broken instrument
   *       at async main (src/supervisor/index.ts:211:26)
   *
   * — before registration, before any state file, on the exact environment
   * `processStartTime`'s own header names as the likely one: "a minimal
   * container image with no procps". `pifleet up` could not start a run there
   * at all. ISC-272's residual (1) said this writer's sentinel was "vacuous —
   * no test makes its `ps` fail"; making it fail showed the sentinel was not
   * merely untested but unreachable.
   *
   * WHAT DEGRADING COSTS, stated rather than buried. `started: ""` is the
   * writers' declared capture-failed sentinel and every reader refuses it, so
   * `down` reports `identity_unrecorded`, signals NOTHING and keeps the
   * checkout. A supervisor recorded this way is therefore live and not
   * cleanly stoppable except by `--force-identity`. That is a worse run than
   * a healthy one and a better one than no run at all — and it is fail-CLOSED
   * in the direction that matters, because the refusal is on the kill path.
   */
  const pgid = (await processGroupId(process.pid).catch(() => null)) ?? 0;
  const started = (await processStartTime(process.pid).catch(() => null)) ?? "";

  /**
   * The event log's secret scrubber, armed from this worker's OWN 0600 env
   * file before the first append (SRD §12.4).
   *
   * ## Why it is armed here and applied at `logEvent`
   *
   * `logEvent` is the single funnel every `events.jsonl` append passes
   * through — it already serialises the writes through `eventsChain`, so there
   * is exactly one place where a record becomes a line. A scrubber anywhere
   * else is a scrubber a future caller can forget, and the failure of
   * forgetting it is silent: the event lands, the log looks normal, and the
   * credential is in it. Putting the control at the seam makes "scrubbed" a
   * property of writing rather than of remembering.
   *
   * ## Why it exists at all
   *
   * A `ticketing` worker was instructed twice — role prompt and mounted
   * skill — never to echo `TICKET_API_TOKEN`. Its second command was
   * `echo $TICKET_API_TOKEN | head -c 20`, and the full 41-character value
   * reached this file, the session transcript, and nothing else that was not
   * meant to hold it. A prompt-level prohibition is not a control. This is.
   *
   * ## Awaited, before the chain exists
   *
   * Deliberately serial with the rest of startup rather than fired off: an
   * async arm would leave a window of events written unscrubbed, and the
   * events written earliest are the ones from the worker's first turns —
   * exactly when `echo $TOKEN` happened. One read of one small file.
   *
   * An unarmed redactor is a supported state (a supervisor pointed at a bare
   * run directory has no env file) and is REPORTED rather than assumed, so
   * "this log was not scrubbed" is something an operator can read off the log
   * itself instead of inferring from an absence.
   */
  const redactor = await redactorForWorkerEnv(wp.envFile);

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
      .then(() =>
        appendJsonl(wp.eventsJsonl, { ts, ...record }, { transform: (line) => redactor.redact(line) }),
      )
      .catch(() => {});
  };

  /*
   * The FIRST line of every event log says what it is and is not protecting.
   *
   * Names only — `armed` and `skipped` are name lists by construction, the
   * same type-level guarantee `WorkerEnvPlan.secretNames` carries — and it is
   * itself scrubbed on the way out, because it goes through `logEvent` like
   * everything else rather than around it.
   *
   * `skipped` is the one that earns its place. A value under
   * `MIN_REDACTABLE_LENGTH` is NOT scrubbed, on purpose (a one-character
   * needle matches everywhere and would eat the log), and an operator whose
   * token is short has no other way to discover that it is travelling
   * unprotected.
   */
  logEvent({
    type: "redaction_armed",
    source: redactor.source,
    armed: redactor.armed,
    skipped: redactor.skipped,
  });

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

  /**
   * How long a blocking `extension_ui_request` may go unanswered before the
   * supervisor reports that it failed to answer it (SRD §12.3 guard 2 —
   * ISC-111, ISC-112).
   *
   * Read from `run.json` HERE, once, rather than per request: the value is
   * fixed for a run by definition (`up` resolved it from `timers.
   * ui_request_timeout` at launch), and re-reading it on the event path would
   * put a file stat inside a handler that must answer a blocked turn promptly.
   * Absent from a run dir written before the key existed → the schema default,
   * which is the `5s` ISC-111 names.
   */
  const uiRequestTimeoutMs = await readRunUiRequestTimeoutMs(run);

  /**
   * Consecutive turns this worker may complete with ZERO tool calls before its
   * task is classified `failed:no_tool_calls` (SRD §5.9 detector 2 / F39 —
   * ISC-108). `0` disables the detector.
   *
   * Read from `run.json` HERE, once, for the same two reasons as the bound
   * above: the value is fixed for a run by definition (`up` resolved it from
   * `run.prose_turns_before_fail` folded with `llm.require_native_tool_calls`
   * at launch), and re-reading it on the event path would put a file stat
   * inside a handler that runs on every record of the stream.
   */
  const proseTurnsBeforeFail = await readRunProseTurnsBeforeFail(run);

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

  /**
   * Latch `session_present` the first time the recorded transcript is on disk
   * (ISC-96's absent-to-present transition), and log it exactly once.
   *
   * ONE definition, called from the write chain below. It used to live inline
   * in the heartbeat, which made the heartbeat's 250 ms period the flag's
   * detection latency — see `flushState` for why that mattered and what it
   * cost. The `!state.session_present` guard is what keeps `session_file_
   * present` a single event rather than one per tick.
   */
  const noteSessionFilePresent = (): void => {
    if (state.session_path === null || state.session_present) return;
    if (!existsSync(state.session_path)) return;
    state.session_present = true;
    logEvent({ type: "session_file_present", path: state.session_path });
  };

  /**
   * ISC-281: the flag is recomputed HERE, immediately before the bytes are
   * written, rather than only on the heartbeat's schedule.
   *
   * `recordSessionPath` sets `session_present` from `existsSync` at the
   * instant `get_state` first reports a path — which is BEFORE the file is
   * created lazily on the first assistant message, so it starts `false`. The
   * correction was made only by the heartbeat, so the flag trailed the
   * transcript's appearance by up to one 250 ms tick, and MEASURABLY did: at
   * the instant `dispatch --auto` exited, a worker that had run a task to
   * completion and whose transcript held 400 tokens still read
   * `session_present: false` on disk, flipping ~400 ms later.
   *
   * Computing it in the chain rather than at the `flushState()` call site is
   * deliberate and matches the note below: the chain always writes the CURRENT
   * state, so the check belongs where the value is serialized, not where the
   * write was requested. Every state.json a reader can observe after any
   * activity therefore carries a flag computed at that write.
   *
   * **What this does NOT claim.** Detection is still by sampling, so a reader
   * polling state.json in the gap between two writes can see a value that went
   * stale after the last one. Polling cannot close that, and the criterion's
   * other arm is what actually holds the line: no consumer that must not lose
   * money reads this flag at all, pinned structurally by
   * `test/unit/session-presence-consumers.test.ts`.
   */
  const flushState = (): Promise<void> => {
    stateChain = stateChain
      .then(() => {
        noteSessionFilePresent();
        return writeWorkerState(wp, state);
      })
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
  /**
   * The F39 runtime detector (SRD §5.9 detector 2 — ISC-108).
   *
   * Constructed ONCE per supervisor because the threshold is a property of the
   * run, and `reset()` at every epoch boundary because the count is a property
   * of the task. It is fed from the LIVE-attributed branch of `onEvent` and
   * read by `maybeProbe`, which is the whole of the wiring — the criterion's
   * grade note recorded that the supervisor already counted tool calls and that
   * "NO VERDICT PATH READS THAT COUNTER", so a counter without the reader below
   * would have been the same shape one file further along.
   */
  const prose = new ProseTurnDetector(proseTurnsBeforeFail);
  const deadline = new Stopwatch();
  let deadlineMs: number | null = null;
  /** Pending kill ladder armed when a deadline `abort` goes unanswered. */
  let abortEscalation: ReturnType<typeof setTimeout> | null = null;
  /**
   * The same ladder, armed when the PROSE detector's `abort` goes unanswered
   * (ISC-108).
   *
   * A separate handle rather than a second use of `abortEscalation`, and the
   * separation is load-bearing rather than tidy: both ladders can be armed at
   * once (the detector trips, and the deadline fires inside the 5 s grace), and
   * a single variable would leak whichever timer was overwritten — leaving a
   * `setTimeout` holding the event loop open with no way left to clear it, on a
   * process whose lifetime must be its child's. `settle` clears both.
   */
  let proseEscalation: ReturnType<typeof setTimeout> | null = null;
  let livePromptId: string | null = null;
  let probing = false;
  let shuttingDown = false;
  /**
   * The host-side worktree of the LIVE epoch, or null when there is no epoch
   * or the task was dispatched without one (ISC-154).
   *
   * Held per-epoch rather than per-worker because it is the live TASK's tree
   * that quiesce is a statement about, and it is cleared in `settle` for the
   * same reason `livePromptId` is: a path left behind from a settled epoch
   * would let a later settlement sample a tree that epoch never owned.
   */
  let liveWorkdir: string | null = null;
  /**
   * The epoch's OWN starting tree hash, and its OWN starting error count
   * (ISC-299).
   *
   * Both are snapshotted when the task envelope arrives rather than read from
   * anywhere global, and each is that way for a measured reason.
   *
   * `liveWorkdirBaseline` is not `up`'s `baselineTree` from `run.json`. That
   * hash predates the worker entirely, so for the SECOND task on a worker it
   * differs from the current tree because task ONE changed it — comparing
   * against it would call every later epoch "changed" no matter what this one
   * did. The only baseline that answers "did THIS epoch change anything" is
   * the tree as it stood when this epoch was handed its prompt.
   *
   * `liveToolErrorsAtStart` exists because `state.tool_errors` is CUMULATIVE
   * over the worker's whole life — nothing resets it, deliberately, since
   * `harvest` reports it as a lifetime total. Reading it raw would let one
   * task's failures condemn the next task's clean epoch.
   */
  let liveWorkdirBaseline: string | null = null;
  let liveToolErrorsAtStart = 0;

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
        /**
         * No quiesce sample exists for a burned epoch, and inventing one now
         * would be a lie about WHEN it was taken (ISC-154).
         *
         * This path runs at STARTUP, recovering an epoch a dead incarnation
         * left live. There was no `settle`, so nothing observed the tree at
         * the moment work stopped — and the tree has since been sitting there
         * for however long the supervisor was down. Hashing it here would
         * label a startup-time measurement as a quiesce-time one, and it
         * would then compare EQUAL to whatever harvest sees, actively
         * certifying that nothing moved. Null says the one true thing: nobody
         * was watching.
         */
        tree_hash: null,
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

  /**
   * ISC-248 — the credential refresher, on THIS supervisor's lifecycle.
   *
   * `TokenRefresher` has existed and been unit-proved since Phase 1 with zero
   * callers: `grep -rn 'security/refresh' src/` returned nothing, so the
   * criterion's verb — *runs* — had no evidence and could have none. The
   * reason it was left unwired was recorded and honest: the refresher attaches
   * to a RUNNING container, and the headless path starts none. That stopped
   * being true when the container launcher landed (ISC-286/287), and `cmd`
   * above is that container's argv.
   *
   * Started here rather than before the spawn because there is nothing to
   * inject INTO until the container exists. Nothing is awaited: minting shells
   * out to gcloud and a supervisor that blocked on it would not read its
   * child's first event until Google answered.
   */
  const refreshAbort = new AbortController();

  if (launch !== null && launch.credential !== null) {
    const cred = launch.credential;
    const containerName = launch.container;

    /**
     * Reflect one injection into `state.credential` and the append-only log.
     *
     * Both, not either: `state` answers "is this worker's credential healthy
     * NOW" for `status`, and the JSONL answers "did the loop re-inject" —
     * which one value cannot, because generation 1 overwrites generation 0.
     */
    const onInjected = (record: CredentialInjection): void => {
      state.credential = {
        injections: (state.credential?.injections ?? 0) + 1,
        generation: record.generation,
        degraded: false,
        last_failure: null,
        last_injected_at: record.injected_at,
      };
      void flushState();
      // Sequenced behind the same chain as events so two injections cannot
      // interleave a partial line into the log.
      eventsChain = eventsChain
        .then(() => appendJsonl(wp.credentialsJsonl, record))
        .catch((err) => logEvent({ type: "credential_record_failed", message: String(err) }));
      logEvent({
        type: "credential_injected",
        generation: record.generation,
        identity: record.identity,
      });
    };

    /**
     * A failed refresh degrades the worker LOUDLY; it does not kill it.
     *
     * The owner's decision, and the reasoning is that the two failures are not
     * the same size: a transient `gcloud` hiccup must not destroy a worker
     * mid-task, but a worker configured `cloud_access: true` that silently has
     * no credential is indistinguishable from a healthy one until some later
     * task fails naming the wrong component. So the flag goes in `state`,
     * where `status` reads it, rather than only into a log nobody opens.
     *
     * `degraded` is cleared by the next SUCCESS (see `onInjected`), not by
     * time — a credential is healthy again when one lands, not when the
     * complaint gets old.
     */
    const onFailure = (failure: RefreshFailure): void => {
      state.credential = {
        injections: state.credential?.injections ?? 0,
        generation: state.credential?.generation ?? 0,
        degraded: true,
        last_failure: failure.error.slice(0, 200),
        last_injected_at: state.credential?.last_injected_at ?? null,
      };
      void flushState();
      logEvent({
        type: "credential_refresh_failed",
        generation_attempted: failure.generation_attempted,
        message: failure.error,
      });
    };

    void (async () => {
      /**
       * The identity is resolved ONCE, here, and not per mint.
       *
       * `resolveIdentity` returns the SA verbatim when impersonating and
       * otherwise reads the host's ADC principal — a local file and at worst
       * one `gcloud config get-value`. Doing it per mint would put that on
       * the 45-minute path for a value that cannot change within a run.
       *
       * Failing to resolve it is NOT fatal and NOT silent: the mint itself is
       * what needs a working gcloud, and it is about to say so far more
       * precisely. The worker id stands in so the record has a non-empty
       * `identity` field rather than an invented account name.
       */
      let identity = argv.workerId;
      try {
        identity = await resolveIdentity(realExec, cred.impersonate_service_account);
      } catch (err) {
        logEvent({ type: "credential_identity_unresolved", message: String(err) });
      }

      const refresher = new TokenRefresher({
        worker: argv.workerId,
        mode: cred.mode,
        intervalS: cred.refresh_s,
        mint: gcloudMinter(realExec, {
          impersonateServiceAccount: cred.impersonate_service_account,
          identity,
        }),
        // Bound to the container NAME from the launch record, never a name
        // this process derived: `down` removes by that name too, and two
        // spellings of one container is the ISC-188 shape.
        inject: (token: string) => injectToken(realExec, containerName, token),
        onInjected,
        onFailure,
      });
      /**
       * `run` ticks immediately — a worker with no token yet is due at 0 — so
       * this IS the initial injection as well as the loop. One code path for
       * both is deliberate: an initial injection written separately is a
       * second place for the mint, the record and the failure handling to
       * drift, and the refresher already treats generation 0 as the initial.
       */
      await refresher.run(refreshAbort.signal);
    })().catch((err) => logEvent({ type: "credential_loop_failed", message: String(err) }));
  }

  const settle = async (verdict: Verdict, reason: string): Promise<void> => {
    const settled = em.settle(verdict, new Date().toISOString());
    if (settled === null) return;
    probing = false;
    livePromptId = null;
    deadlineMs = null;
    const settledWorkdir = liveWorkdir;
    const settledBaseline = liveWorkdirBaseline;
    const settledToolErrors = state.tool_errors - liveToolErrorsAtStart;
    liveWorkdir = null;
    liveWorkdirBaseline = null;
    // Disarm the kill ladder: the epoch is over. Leaving it armed would keep
    // the event loop alive and, worse, let a timer from a settled epoch fire
    // against whatever epoch is live by then.
    if (abortEscalation !== null) {
      clearTimeout(abortEscalation);
      abortEscalation = null;
    }
    if (proseEscalation !== null) {
      clearTimeout(proseEscalation);
      proseEscalation = null;
    }
    tracker.reset();
    /**
     * Cleared for exactly the reason `livePromptId` and `liveWorkdir` are
     * cleared two lines up (ISC-108): a prose streak carried across a settle
     * would let ONE task's degradation classify the NEXT task on the same
     * worker. The epoch is the unit this verdict is about, so the count has to
     * die with it — including the latch, which has already been read by the
     * caller that decided the verdict now being written.
     */
    prose.reset();
    await persistFence();
    /**
     * The ISC-154 quiesce sample, taken HERE and nowhere else.
     *
     * This line is the whole reason quiesce is a meaningful moment rather
     * than a word in a docstring. `settle` is where the supervisor declares
     * the epoch over — the agent has stopped, the completion probe has
     * confirmed it twice, and from this instant nothing is SUPPOSED to write
     * to the tree again. Sampling anywhere else measures a different claim:
     * earlier and the agent is still working, later and the sample is taken
     * by whoever is asking, which is the failure below.
     *
     * It is taken on EVERY settle path, not just the quiesced one. A task
     * that timed out, was aborted, or died with its worker is exactly the
     * task most likely to have left something running, and those are the
     * paths where a stale-tree void matters most.
     *
     * `worktreeContentHash` cannot throw and cannot hang past its own
     * timeout, both of which are load-bearing here: `settle` is the only
     * writer of the record `wait` polls, so an exception or a wedged git in
     * this line would not degrade the evidence, it would hang the task
     * forever. Failure yields null, which the adjudicator reads as no
     * evidence and which changes no verdict.
     *
     * AND THE REASON IS NOW WRITTEN DOWN (2026-08-26). `null` is three
     * different facts wearing one face — git timed out, git failed, or the
     * snapshot threw — and until this callback existed none of them reached
     * the record. A CI run on 2026-08-26 settled `success`/`quiesced` with a
     * null hash and the chain probe reported "the supervisor took no quiesce
     * sample"; nothing anywhere said whether the 10s bound had been hit or
     * git had refused, so the failure was undiagnosable from the artifacts by
     * design rather than by accident.
     *
     * The verdict is UNCHANGED by this: a missing hash still voids nothing.
     * What changes is that the next occurrence can be read rather than
     * guessed at.
     */
    /**
     * THE THIRD CAUSE, named — because "no failure event" was ambiguous.
     *
     * A null `tree_hash` has three origins and the diagnostic above covered
     * only one of them. `worktreeContentHash` failing emits
     * `quiesce_sample_failed` with a reason; but `settledWorkdir === null`
     * emits NOTHING and produces the identical null, so a reader who found no
     * failure event could not tell "the sampler ran and could not answer"
     * from "the sampler was never called" from "the event has not flushed
     * yet". Three different bugs behind one silence.
     *
     * Measured, not hypothetical: on 2026-08-27 a `container-live` run failed
     * `expect(record.tree_hash).not.toBeNull()` and the reason was
     * unrecoverable — the diagnostic added for exactly that moment had no
     * event to show, and nothing said whether that meant it had not fired or
     * had not been reached.
     *
     * A skip is not a failure and is not logged as one: a task dispatched
     * with no worktree is a legitimate shape (`"unset"` and `""` are the
     * envelope's two spellings of it), so this records WHY the sample was not
     * taken rather than complaining that it wasn't.
     */
    const treeHash =
      settledWorkdir === null
        ? (logEvent({
            type: "quiesce_sample_skipped",
            task: settled.task_id,
            reason: "the epoch owns no host workdir, so there is no tree to sample",
          }),
          null)
        : await worktreeContentHash(settledWorkdir, {
            onFailure: (reason) =>
              logEvent({ type: "quiesce_sample_failed", task: settled.task_id, reason }),
          });

    /**
     * THE ISC-299 READER. The epoch ended cleanly; this decides whether it
     * ended having DONE anything.
     *
     * Sited here, after the quiesce sample, and that placement is forced
     * rather than chosen: the verdict chain that calls `settle` runs before
     * this line exists, so the tree evidence simply is not available where the
     * verdict is first picked. Moving the sample earlier was the alternative
     * and was rejected — its own docstring above explains why the instant it
     * is taken at is the whole meaning of the measurement.
     *
     * WHY THIS EXISTS. Measured 2026-08-25 on the first Linux CI run of the
     * whole chain: a worker made 17 native tool calls, ELEVEN of which the
     * filesystem refused (`EACCES: permission denied, open '/workspace/add.js'`),
     * wrote nothing, and settled `success`. `dispatch --auto` reported
     * `verdict: success` and an operator would have been told the task worked.
     * That is F39's shape — "worker looks healthy, streams, settles, and does
     * nothing" — one step over from where the ISC-108 reader catches it: that
     * reader asks whether tools were CALLED, and seventeen were.
     *
     * THE PREDICATE IS A CONJUNCTION, and each term is load-bearing:
     *
     *  - `verdict === "success"` — this only ever DOWNGRADES. A `timed_out`,
     *    `aborted` or already-`failed` epoch is telling the operator something
     *    true, and routing them to a deadline or an abort is more useful than
     *    relabelling it. Nothing here can upgrade a failure.
     *  - `settledToolErrors > 0` — errors THIS epoch, not the worker's
     *    lifetime total. Without this term a legitimately read-only task
     *    ("summarise these files") would be condemned for changing nothing,
     *    which is exactly what it was asked to do.
     *  - the tree is byte-identical to how this epoch found it. This is the
     *    model-independent half: whatever the agent believed it did, the disk
     *    disagrees.
     *
     * Deliberately NOT "any tool error fails the epoch". A model that mistypes
     * a path once and then recovers has done the work, and failing it would
     * make the fleet lie in the other direction — which is the same defect
     * with the sign flipped, not a fix for it.
     *
     * Both null checks are refusals to guess. A null `treeHash` means the hash
     * could not be taken (`worktreeContentHash` yields null rather than
     * throwing), and a null baseline means this epoch never had a worktree;
     * in both cases there is NO evidence about work done, and no evidence must
     * not read as evidence of failure.
     */
    let recordedVerdict = verdict;
    let recordedReason = reason;
    if (
      verdict === "success" &&
      settledToolErrors > 0 &&
      treeHash !== null &&
      settledBaseline !== null &&
      treeHash === settledBaseline
    ) {
      recordedVerdict = "failed";
      recordedReason = NO_WORK_DONE_REASON;
      logEvent({
        type: "no_work_done_detected",
        epoch: settled.epoch,
        task_id: settled.task_id,
        tool_errors: settledToolErrors,
        tree_hash: treeHash,
      });
    }

    await writeTaskRecord(taskRecordPath(wp, settled.task_id), {
      schema: "pifleet.taskrecord/v1",
      task_id: settled.task_id,
      attempt_id: settled.attempt_id,
      worker: argv.workerId,
      run_id: argv.runId,
      epoch: settled.epoch,
      verdict: recordedVerdict,
      reason: recordedReason,
      settled_at: new Date().toISOString(),
      tree_hash: treeHash,
    });
    state.phase = shuttingDown ? state.phase : "idle";
    state.task_id = null;
    state.completed_epochs = [...state.completed_epochs, settled.epoch];
    await flushState();
    await ledger.append("settled", {
      worker: argv.workerId,
      task_id: settled.task_id,
      epoch: settled.epoch,
      detail: { verdict: recordedVerdict, reason: recordedReason },
    });
    logEvent({
      type: "settled",
      task_id: settled.task_id,
      epoch: settled.epoch,
      verdict: recordedVerdict,
      reason: recordedReason,
    });
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
    // The child is gone, so no answer can ever land and no deadline can say
    // anything useful about one. Same reasoning as the shutdown path, reached
    // by the other route: a dead child is not an unanswered dialog.
    clearUiDeadlines();
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
          /**
           * THE ISC-108 READER. The epoch quiesced; this decides what it
           * quiesced AS.
           *
           * Before this branch existed the chain below was the whole of the
           * verdict — `timed_out`, else `aborted`, else `success` — which is
           * why a worker that streamed reasoning prose for three turns and
           * never called a tool settled `success`, with a clean empty diff, and
           * looked exactly like a task that had nothing to do. F39's "worker
           * looks healthy, streams, settles, and does nothing", certified.
           *
           * PRECEDENCE: the prose trip outranks `timed_out` and `aborted`, and
           * that ordering is a decision rather than an accident of where the
           * line was inserted.
           *
           * `timed_out` and `aborted` describe HOW the epoch ended. The prose
           * trip says WHY it had to. A verdict's job here is to route the
           * operator to the remediation, and those two route differently:
           * `timed_out` sends them to raise `per_task_timeout`, which fixes
           * nothing when the model has stopped emitting tool calls, while
           * `no_tool_calls` sends them to change the model, which does. The
           * same reasoning ISC-116 used one branch down to prefer `timed_out`
           * over `aborted` — "a deadline abort is a timeout that happened to be
           * polite" — taken one step further: a diagnosis outranks a
           * description of the ending.
           *
           * The window in which the choice is even reachable is small and worth
           * stating, because it bounds the blast radius. Once the detector
           * trips it TEARS THE EPOCH DOWN itself (abort, then the ladder at
           * `ABORT_GRACE_MS`), so `prose.tripped` can only coincide with
           * `em.timedOut` when a deadline fires inside those 5 s. It cannot
           * coincide with an abort THE DETECTOR sent, because the trip path
           * deliberately does not call `em.noteAbortRequested()` — see there.
           */
          let verdict: Verdict;
          let reason: string;
          if (prose.tripped) {
            verdict = "failed";
            reason = NO_TOOL_CALLS_REASON;
          } else if (em.timedOut) {
            verdict = "timed_out";
            reason = "quiesced";
          } else if (em.abortRequested) {
            verdict = "aborted";
            reason = "quiesced";
          } else {
            verdict = "success";
            reason = "quiesced";
          }
          await settle(verdict, reason);
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
  // Extension UI requests (SRD §4.2 / §12.3 guard 2 — ISC-111, ISC-112, ISC-113)
  // -------------------------------------------------------------------------

  /**
   * Deadlines armed on dialogs whose answer has not yet been confirmed sent,
   * keyed by request id. Empty in the normal case: the answer is written
   * synchronously and the entry is cleared in the same tick.
   */
  const uiDeadlines = new Map<string, ReturnType<typeof setTimeout>>();

  const clearUiDeadlines = (): void => {
    for (const t of uiDeadlines.values()) clearTimeout(t);
    uiDeadlines.clear();
  };

  /**
   * Answer one `extension_ui_request`, or deliberately do not (§12.3 guard 2).
   *
   * THE COUNTER SPLIT, AND WHY `answered` DOES NOT MOVE. §12.3 is explicit that
   * there is no "deny" verb and that "denial is `{cancelled:true}`" — so every
   * frame this function sends is a DENIAL and increments `ui_requests.denied`.
   * `ui_requests.answered` is left for a SUBSTANTIVE answer (`{value}` /
   * `{confirmed}`), which this supervisor never produces and structurally
   * cannot: there is no human on this end of a headless fleet, so there is
   * nothing it could truthfully say a user chose. The two counters are
   * therefore DISJOINT and `answered + denied` is the number of dialogs replied
   * to. That is the reading that stays unambiguous — were `answered` a
   * superset, `{answered: 3, denied: 3}` could not be told apart from three
   * approvals alongside three denials, and the field would carry no information
   * the other one did not. `answered` staying 0 for every run today is a fact
   * about the policy, not an oversight, and it is what an approval seam (a
   * human in the loop, or a rule that permits a specific `confirm`) would move.
   *
   * Requests that could not be answered at all — no usable `id` — move NEITHER
   * counter. They were not answered and they were not denied; they were
   * undeliverable, and folding them into `denied` would overstate what the
   * supervisor actually did on the wire. They are logged instead.
   *
   * WHY THE ANSWER IS IMMEDIATE AND NOT DEFERRED TO THE TIMER. SRD §12.3 says
   * "after `ui_request_timeout`" and ISC-111 says "within 5s", and those two
   * only look like the same instruction. `ui_request_timeout` is a CEILING —
   * the longest a turn may sit blocked — and waiting it out would spend the
   * entire ISC-111 budget to arrive at an identical outcome: per the installed
   * `rpc-mode.js`, `cancelled:true` resolves select/input/editor to `undefined`
   * and confirm to `false`, which is byte-for-byte the `defaultValue` those
   * methods reach when their OWN optional timeout fires. A waited-out
   * cancellation and a prompt one are indistinguishable to the extension. So
   * the deadline below is a WATCHDOG on this function, not its schedule.
   */
  const handleUiRequest = (event: RpcEvent, seq: number): void => {
    const plan = classifyUiRequest(event);

    if (plan.action === "ignore") {
      // ISC-113's half: logged (by the `logEvent` above, verbatim) and NOT
      // answered. Nothing registered a resolver for this id on the far side,
      // so a reply would be addressed to nobody.
      logEvent({ type: "ui_request_ignored", seq, method: plan.method, class: "fire_and_forget" });
      return;
    }

    if (plan.action === "unanswerable") {
      // Not a policy choice — `id` is the correlation key the child's
      // dispatcher looks the answer up by, so there is no frame to send. Loud
      // because a real dialog arriving this way WILL hang its turn, and this
      // line is the only place that can say why before the kill ladder reports
      // the symptom 25 minutes later.
      logEvent({ type: "ui_request_unanswerable", seq, method: plan.method, reason: plan.reason });
      void ledger.append("ui_request_unanswerable", {
        worker: argv.workerId,
        detail: { method: plan.method, reason: plan.reason },
      });
      return;
    }

    /**
     * `editor` is the one method with no other unblocker (SRD §4.2), which is
     * why ISC-112 is a criterion separate from ISC-111. Carried explicitly out
     * of the classification table so the failure path below can branch on it
     * rather than treating all four dialogs as interchangeable.
     */
    const soleUnblocker = plan.unblocker === "supervisor_only";
    const elapsed = new Stopwatch();

    /**
     * Armed BEFORE the write and cleared after it, so the only way it survives
     * to fire is an answer that never left. That is not a hypothetical: a
     * closed or broken stdin throws out of `sendUncorrelated`, and for an
     * `editor` request that means a turn which cannot recover by any other
     * route. The timer is what turns "we failed to answer" from a silence into
     * a dated line at the bound the operator configured.
     *
     * `unref` so a pending deadline can never be the reason this process
     * outlives its child.
     */
    const deadline = setTimeout(() => {
      uiDeadlines.delete(plan.id);
      logEvent({
        type: "ui_request_deadline_exceeded",
        seq,
        id: plan.id,
        method: plan.method,
        sole_unblocker: soleUnblocker,
        timeout_ms: uiRequestTimeoutMs,
      });
      if (soleUnblocker) {
        // ISC-112 exactly. Nothing downstream rescues this turn: the agent
        // holds until `per_task_timeout`, then the deadline path settles it
        // `timed_out` with `deadline_exceeded_no_terminal_event` — a reason
        // that names the symptom and not the cause. This is the cause.
        void ledger.append("ui_dialog_unanswered", {
          worker: argv.workerId,
          detail: { id: plan.id, method: plan.method, timeout_ms: uiRequestTimeoutMs },
        });
      }
    }, uiRequestTimeoutMs);
    deadline.unref?.();
    uiDeadlines.set(plan.id, deadline);

    try {
      client.sendUncorrelated(cancelledResponse(plan.id));
    } catch (err) {
      // Left ARMED on purpose. The write failing is exactly the condition the
      // deadline exists to report, and reporting it at the configured bound
      // keeps one code path for "no answer landed" however that came about.
      logEvent({
        type: "ui_request_answer_failed",
        seq,
        id: plan.id,
        method: plan.method,
        sole_unblocker: soleUnblocker,
        message: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    clearTimeout(deadline);
    uiDeadlines.delete(plan.id);
    state.ui_requests.denied++;
    logEvent({
      type: "ui_request_denied",
      seq,
      id: plan.id,
      method: plan.method,
      sole_unblocker: soleUnblocker,
      unrecognised: plan.unrecognised,
      // The ISC-111 measurement, in band. A test can time this from outside,
      // but a number the supervisor recorded itself survives into a run
      // directory an operator reads months later.
      elapsed_ms: elapsed.elapsedMs(),
      timeout_ms: uiRequestTimeoutMs,
    });
    void flushState();
  };

  // -------------------------------------------------------------------------
  // Event handling — stream-seq attribution first, everything else second.
  // -------------------------------------------------------------------------

  /**
   * The prose detector tripped: `prose_turns_before_fail` consecutive turns of
   * this epoch completed with zero tool calls (SRD §5.9 detector 2 / F39 —
   * ISC-108). Called on the trip EDGE, exactly once per epoch.
   *
   * Three things happen here, and the first two are the whole point of the
   * detector living at runtime rather than in the harvester:
   *
   * 1. **It is recorded, now.** §5.9's promise is that this "converts the
   *    silent failure into a loud one at ~3 turns instead of ~1 hour", and a
   *    verdict written at settle is not ~3 turns — it is whenever the agent
   *    happens to stop. The `events.jsonl` line and the ledger row are dated at
   *    the turn that crossed the threshold, so `logs` and `report` can say when
   *    the worker stopped acting even for a run that was killed before it
   *    settled anything.
   *
   * 2. **The epoch is torn down** rather than left to burn the rest of
   *    `per_task_timeout` against `tokens_ceiling`. That budget is the ~1 hour
   *    in §5.9's sentence: a model degraded under a long context does not
   *    recover by being given more of it, and a `followUp` loop will happily
   *    produce prose until the deadline. Teardown also has a second effect
   *    worth naming — it is what keeps `prose.tripped` reachable at settle. Let
   *    the deadline get there first and the task settles `timed_out`, and the
   *    criterion's `failed:no_tool_calls` would be a verdict nothing could
   *    observe.
   *
   * 3. It uses the SAME ladder shape as the deadline branch — advisory `abort`
   *    first, kill only if it goes unanswered — rather than settling on the
   *    spot. Settling while the child is still streaming would leave a live
   *    agent writing into a settled epoch, which is precisely the §7.5
   *    straggler hazard the fence exists to contain. Ask politely; escalate if
   *    ignored. `aborted.json` is the agent that honours it and `deaf-abort`
   *    the one that does not, and both paths end in a settled epoch.
   *
   * NOTE what is deliberately NOT called: `em.noteAbortRequested()`. The
   * deadline branch sets it because a deadline abort really is the task being
   * stopped from outside, and the fence records that for forensics. Here it
   * would put `abort_requested: true` in `fence.json` for an abort no operator
   * sent, and — before the verdict chain in `maybeProbe` was ordered the way it
   * is — would have relabelled this epoch `aborted`, erasing the diagnosis with
   * a side effect of the diagnosis itself. The abort is a mechanism here, not a
   * fact about intent.
   */
  const onProseTrip = (): void => {
    const live = em.live;
    logEvent({
      type: "no_tool_calls_detected",
      task_id: live?.task_id ?? null,
      epoch: live?.epoch ?? null,
      // The measurement, in band: a number the supervisor recorded itself
      // survives into a run directory an operator reads months later, which a
      // test timing it from outside does not.
      prose_turns: prose.streak,
      threshold: prose.threshold,
    });
    void ledger.append("no_tool_calls", {
      worker: argv.workerId,
      ...(live === null ? {} : { task_id: live.task_id, epoch: live.epoch }),
      detail: { prose_turns: prose.streak, threshold: prose.threshold },
    });
    void client.send("abort").catch(() => {});
    proseEscalation = setTimeout(() => {
      proseEscalation = null;
      if (em.live === null) return; // the abort landed; nothing to escalate.
      logEvent({ type: "no_tool_calls_escalated", epoch: em.live.epoch });
      // `.catch` BEFORE `.finally`, for the reason the deadline ladder spells
      // out at length: `settle()` awaits two unguarded durable writes, and a
      // bare `void p.finally(...)` would re-raise an ENOSPC rejection as an
      // unhandled one, taking the supervisor down mid-transition.
      void settle("failed", NO_TOOL_CALLS_REASON)
        .catch((err: unknown) => {
          logEvent({ type: "settle_failed", reason: String(err) });
        })
        .finally(() => {
          // A child that ignored abort is not trustworthy to run the next task.
          child.kill();
        });
    }, ABORT_GRACE_MS);
  };

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

    /**
     * AFTER the verbatim log and BEFORE epoch attribution, and it does not
     * return (SRD §12.3 guard 2 — ISC-111, ISC-112, ISC-113).
     *
     * After the log because ISC-113 asserts every UI request reaches
     * `events.jsonl` intact whether or not it is answered, so the record must
     * not be conditional on the branch below it. Before attribution because a
     * blocking dialog must be answered no matter which epoch it belongs to —
     * an `editor` request attributed to a settled epoch still holds the
     * child's turn, and a supervisor that answered only live-epoch dialogs
     * would hang on exactly the straggler case §7.5 exists to handle.
     *
     * Falls THROUGH rather than returning so the existing attribution and
     * `tracker.observe` path is unchanged for this event type — the same path
     * it took before there was a responder. Answering is strictly additive.
     */
    if (event.type === "extension_ui_request") handleUiRequest(event, seq);

    if (event.type === "agent_start" && em.live !== null && !em.windowOpen) {
      if (em.bindStart(seq)) {
        tracker.reset();
        // Reset alongside the tracker, not only in `settle` (ISC-108). `settle`
        // covers the epoch that ENDED; this covers the epoch that begins —
        // including the one a crashed predecessor left burned, whose counts
        // this incarnation never saw and must not inherit.
        prose.reset();
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
      /**
       * THE ISC-108 COUNTER, fed from the LIVE branch and nowhere else.
       *
       * Note what this is NOT: `state.tool_calls++` in the switch at the top of
       * this function. That one is cumulative across the worker's whole life
       * and — because the switch runs BEFORE `em.attribute` — it also counts a
       * straggler `tool_execution_end` belonging to an epoch that settled
       * minutes ago. Harmless for a metric `harvest` prints; wrong for a
       * verdict. Counting here instead means a prior epoch's tool call can
       * never clear THIS epoch's prose streak, which would silently disarm the
       * detector on exactly the §7.5 interleaving the fence exists to handle.
       *
       * `interrupted` is the second half of that care. A `turn_end` arriving
       * after the supervisor asked this epoch to stop has zero tool calls
       * because WE ended it — see `ProseTurnDetector` for why counting it would
       * send an operator to change a model when the answer was a longer
       * deadline.
       */
      if (prose.observe(event.type, { interrupted: em.timedOut || em.abortRequested })) {
        onProseTrip();
      }
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
    // The absent→present transition (ISC-96) is latched by
    // `noteSessionFilePresent`, which `flushState` calls at the bottom of this
    // tick. It used to be checked inline here, which made this interval's
    // period the flag's detection latency (ISC-281).
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
        /**
         * Remember which tree this epoch owns, so `settle` can sample it
         * (ISC-154). `"unset"` and `""` are the envelope's two spellings of
         * "this task has no worktree" — the same pair `harvestTask` guards on
         * — and both must stay null rather than becoming a path that would
         * make git run somewhere arbitrary.
         */
        liveWorkdir =
          envelope.host_workdir === "unset" || envelope.host_workdir === ""
            ? null
            : envelope.host_workdir;
        /**
         * This epoch's own starting point, for ISC-299's reader in `settle`.
         *
         * Taken HERE — after the workdir is known and BEFORE the prompt goes
         * out — because that is the last instant at which the tree is
         * guaranteed to be untouched by this epoch. A sample taken after the
         * prompt races the agent's first write and would silently make the
         * comparison vacuous: the baseline would already include the change it
         * exists to detect.
         *
         * `worktreeContentHash` cannot throw and is bounded by its own
         * timeout, so this cannot wedge the dispatch path; a failure yields
         * null, which the reader treats as no evidence and which changes no
         * verdict.
         *
         * IT DOES COST, and the cost is stated rather than left to be
         * discovered. This is `git add -A` plus `write-tree`, so dispatch now
         * blocks on hashing the whole worktree and the per-epoch hashing cost
         * DOUBLES — `settle` was already paying one. Measured on this
         * repository (309 tracked files) at 80-130 ms; it scales with the
         * tree, so a large monorepo will pay noticeably more.
         *
         * Taking it off the dispatch path was considered and rejected: an
         * asynchronous sample races the agent's first write, and a baseline
         * that already contains the change it exists to detect makes the whole
         * comparison vacuously equal. A slower dispatch is recoverable; a
         * silently inert reader is the failure this criterion is about.
         */
        liveWorkdirBaseline =
          liveWorkdir === null
            ? null
            : await worktreeContentHash(liveWorkdir, {
                // Same side channel as the quiesce sample above, same reason.
                onFailure: (reason) => logEvent({ type: "live_sample_failed", reason }),
              });
        liveToolErrorsAtStart = state.tool_errors;

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
       * one that writes it. Pi renders into a unique file under the worker's
       * `exportsDir`; the supervisor reports where; the CLI copies it into
       * place. Exactly ONE process ever names the operator's file, and it is
       * the process that told the operator what the file is.
       *
       * ISC-276: THE SUPERVISOR NO LONGER ACCEPTS A PATH AT ALL. It used to,
       * and the staging file was a SIBLING of the operator's — which kept the
       * CLI's rename same-directory and therefore atomic and never
       * cross-device, and was the reason the parameter survived the ISC-234
       * race fix. But a sibling of an attacker-chosen path is an
       * attacker-chosen path: the caller still picked the directory, still
       * picked the basename prefix, and Pi still wrote there with Pi's
       * authority. The race fix changed WHICH process performed the final
       * write; it changed nothing about which files were reachable, and it is
       * worth saying so plainly rather than letting the improvement read as a
       * containment it never was.
       *
       * So the destination is now derived ENTIRELY from the run directory —
       * `wp.exportsDir` plus a UUID — and a request that carries `path` is
       * REFUSED rather than served with the field ignored. Three reasons, in
       * ascending order of how much they matter:
       *
       *   1. The supervisor makes no decision from it. A parameter that
       *      changes nothing still advertises influence, and the next reader
       *      of this block would reasonably assume it steers the write, which
       *      is the belief the paragraph above exists to correct.
       *   2. Silence is the worse failure for a client from an older build.
       *      Ignoring its `path` leaves it renaming a run-dir file across a
       *      filesystem boundary and reporting `EXDEV` — a true statement
       *      about the wrong subject. Refusing puts the reason in the reply,
       *      and `transcript.ts` already prints a refusal on stderr and falls
       *      back to the local render, so the operator still gets a document
       *      and now also gets the sentence explaining it.
       *   3. It is the OBSERVABLE the criterion names. ISC-276's probe is "the
       *      reply is a refusal and no file is written anywhere the path
       *      named". Ignoring the field would leave a probe with only the
       *      negative half, and a negative alone cannot tell containment apart
       *      from an export that failed for some unrelated reason. A refusal
       *      pairs a positive assertion with it.
       *
       * Where the operator's file ends up is now the CLI's own business and
       * never travels over this socket. It never needed to: the CLI is the
       * process the operator typed `--html` at, and it was already the only
       * writer of that path.
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
       * staging path, the CLI's claim fails ENOENT, and the export degrades to
       * the local render instead of reporting a success that wrote nothing —
       * unchanged by ISC-276, since `exportsDir` is no more visible inside the
       * container namespace than the operator's desktop was.
       */
      case "export_html": {
        // ISC-276. `in` rather than a type check on purpose: the objection is
        // to the field EXISTING, not to its shape. `{"path": null}` and
        // `{"path": 7}` are callers that believe they are steering this write
        // just as much as `{"path": "/etc/cron.d/x"}` is, and all three should
        // hear that they are not.
        if ("path" in msg) {
          return {
            ok: false,
            error:
              "export_html does not accept a path (ISC-276): the render is staged inside the run directory and the caller places it",
          };
        }
        // Derived from the run directory and a UUID, and from nothing else.
        // `randomUUID` emits only hex and dashes, so there is no separator, no
        // traversal and no absolute prefix that could reach out of the
        // directory this joins onto — containment by construction.
        const staging = join(wp.exportsDir, `pi-export-${randomUUID()}.html`);
        // Belt and braces over the line above, asserted rather than assumed —
        // see `isInsideRunTree` for why the predicate is the smaller half of
        // this and what it is for. On today's derivation it cannot fire.
        if (!isInsideRunTree(run.root, staging)) {
          return {
            ok: false,
            error: `export_html: refusing to stage outside the run directory (ISC-276): ${staging}`,
          };
        }
        try {
          // Pi is handed a full path, not a directory, and real Pi is under no
          // obligation to create parents. Cheaper to guarantee the directory
          // here than to discover its absence as an opaque render failure 8s
          // later — and lazily, in the handler, because most runs never
          // export and an empty `exports/` in every worker directory would be
          // a permanent artefact of a feature nobody used.
          await mkdir(wp.exportsDir, { recursive: true });
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
    /**
     * Disarm any UI deadline still outstanding BEFORE the abort below.
     *
     * A dialog whose answer never landed is about to stop mattering: the turn
     * is being aborted and the child's stdin closed, so the deadline firing
     * during shutdown would append `ui_request_deadline_exceeded` — and, for
     * an `editor`, a `ui_dialog_unanswered` ledger entry — describing a hang
     * that an operator-requested stop had already made moot. The ledger is
     * read to explain why a run went wrong; a shutdown must not write
     * incidents into it.
     */
    clearUiDeadlines();
    /**
     * Stop the refresher BEFORE the container goes away.
     *
     * `run()` races each tick against this signal and passes it into its
     * sleep, so abort is observed immediately rather than at the next
     * 45-minute wake — without which the process had a pending timer and a
     * live loop and would not exit at all (recorded at `defaultSleep`). An
     * in-flight mint is not cancelled, only stopped being waited on: nothing
     * here can safely unwind a half-finished injection.
     */
    refreshAbort.abort();
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
