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
import { mkdir, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import {
  TaskEnvelopeSchema,
  type RpcEvent,
  type RpcResponse,
  type RpcSessionState,
  type TaskEnvelope,
  type Verdict,
  type WorkerState,
} from "../contracts.ts";
import { appendJsonl } from "../util/jsonl.ts";
import { RpcClient, RpcTimeoutError, Stopwatch } from "../rpc/client.ts";
import { isoNow } from "../util/clock.ts";
import { CompletionTracker } from "../rpc/completion.ts";
import { EpochManager, type CancelDecision, type DispatchDecision } from "../rpc/epoch.ts";
import { isInsideRunTree, runPaths, taskRecordPath, workerPaths } from "../run/paths.ts";
import { writeTaskPolicy } from "../run/task-policy.ts";
import { clearDispatchPolicy } from "../run/dispatch-policy.ts";
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
import {
  SESSION_REDISCOVER_MS,
  TUI_POLL_MS,
  TUI_QUIET_MS,
  quietWindowMsFor,
  attributedToStage,
  classifyTuiTurn,
  detachedDockerArgv,
  discoverSessionPath,
  verdictForStopReason,
} from "./tui.ts";
import { TOOL_LOOP_REASON, isToolLoop, readToolLoop } from "./tool-loop.ts";
import { TranscriptReader } from "../harvest/transcript.ts";

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
  const redactor = await redactorForWorkerEnv(wp.envFile, wp.secretsDir);

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
    unresolved: redactor.unresolved,
  });

  /*
   * A GRANTED NAME THIS REDACTOR CANNOT SEE IS SHOUTED ABOUT, on stderr, where
   * an operator is already looking at `up` output.
   *
   * `unresolved` is not `skipped`. Skipped means the value was found and
   * judged not worth a needle; this means the run granted a credential and the
   * redactor cannot reach it — so every event this supervisor writes about
   * that variable is unprotected while the log's own first line says the
   * redactor is running.
   *
   * It is deliberately NOT fatal. Refusing to start would trade a degraded log
   * for no fleet at all, which is the same trade the absent-env-file branch
   * declines. But it is also deliberately not just a field in a JSON line: the
   * defect that produced this field went unnoticed precisely because its only
   * symptom was a value quietly missing from a structure nobody re-read.
   */
  if (redactor.unresolved.length > 0) {
    process.stderr.write(
      `pifleet: WARNING — ${wp.workerId} granted secret(s) the event-log redactor could not ` +
        `value: ${redactor.unresolved.join(", ")}. Events mentioning them are NOT scrubbed. ` +
        `This usually means secret delivery moved and a reader did not follow.\n`,
    );
  }

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
   * IS THIS AN ATTENDED WORKER (SRD §3.5)? Decided ONCE, here, from the record.
   *
   * Every branch below reads this variable and none of them re-derives the
   * answer, because the two halves of the decision must not be able to
   * disagree: a supervisor that launches the container detached but then opens
   * an RPC client on a `docker run -d` process's stdout waits forever on a
   * stream that carries one container ID and closes, and a supervisor that
   * does the reverse never launches at all.
   *
   * `launch === null` — the `PIFLEET_PI_COMMAND` double path — is `rpc` and
   * cannot be anything else. The double is a plain process on this host, there
   * is no container to detach and no terminal to attach to, and the whole
   * mode is about a container's TTY. Reading the field off a record that does
   * not exist would have to invent a default; this states the answer instead.
   */
  const tuiMode = launch !== null && launch.pane_mode === "tui";

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
    /**
     * THE ONE EXCEPTION to "a container's argv is used VERBATIM", and it is an
     * exception to the letter of that rule rather than to its reason.
     *
     * The paragraph above forbids the supervisor APPENDING to the argv, and
     * the reason it gives is about the WORKER's contract: `--session-dir` and
     * friends are container paths, and host paths appended here would send Pi's
     * transcripts somewhere the harvest cannot find them. Nothing about `-d`
     * touches that. It is a flag to the docker CLI describing THIS process's
     * relationship to the container — foreground or detached — and this process
     * is the only one that knows what that relationship has to be.
     *
     * It is applied here rather than in `render.ts` because `pifleet render`
     * prints a command a human can paste, and in a human's terminal the
     * foreground `-i -t` form is the correct one; `-d` is required only because
     * the supervisor spawns with `stdin: "pipe"`, and docker refuses `-t` in
     * the foreground when its own stdin is not a terminal. Putting it in the
     * renderer would also move an `rpc` worker's argv, which `render.test.ts`
     * pins byte for byte precisely so that it cannot move.
     *
     * `detachedDockerArgv` throws on an argv that is not `docker run …` or that
     * already carries `-d`. Both are fail-stop rather than best-effort: a
     * silently un-detached tui launch is the `the input device is not a TTY`
     * error, which does not mention `pane_mode` and sends the next reader to
     * the wrong file.
     */
    cmd = tuiMode ? detachedDockerArgv(launch.argv) : launch.argv;
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
  /**
   * A STAGED epoch's deadline, held UNSTARTED until the turn begins (§9 Q1).
   *
   * `deadlineMs` is the armed clock: the heartbeat compares `deadline.elapsedMs()`
   * against it, so writing it is what starts the countdown. The RPC route sets
   * both in the same breath as the prompt send, which is right there because
   * the turn begins in the same millisecond.
   *
   * A staged epoch's turn begins when a person presses a key — immediately, in
   * ten minutes, or never. Setting `deadlineMs` at stage time would make a
   * 20-minute task staged before lunch `timed_out` before it began, and D6
   * names that as one of its two non-cosmetic costs. So the value is parked
   * here, where nothing reads it, and moved to `deadlineMs` at the trigger.
   *
   * While it is parked the epoch has NO deadline at all. That is deliberate and
   * it is the lesser of the two errors: an untriggered stage is released by
   * `unstage`, which is a verb an operator can reach, whereas a task killed by
   * a clock that started before it did is a failure with no remedy and a
   * misleading verdict attached.
   */
  let stagedDeadlineMs: number | null = null;
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
    // Both clocks, and the parked one for the same reason as the armed one: a
    // staged epoch that settled before its trigger (a `failed` on restart, say)
    // would otherwise leave its deadline parked, and the NEXT stage's first
    // transcript growth would arm the PREVIOUS task's number.
    stagedDeadlineMs = null;
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

    /**
     * ── DISARM THE DROP, AND DO IT BEFORE THE RECORD IS VISIBLE (ISC-1114) ──
     *
     * `/policy/dispatch` is the ONLY thing the auto-trigger extension can see.
     * It fires on `(task_id, epoch)` and dedups on that pair — but `lastFired`
     * is closure state belonging to one Pi session, and a session does not
     * survive `/new`. So a drop still reading `staged: true` after its epoch
     * closed is not stale cosmetics: it is a LOADED TRIGGER, and the next
     * session start pulls it.
     *
     * That is the reset race, measured on the live triage console
     * (run `2026-09-09T04-21-26Z-20f5`, every sweep of it):
     *
     *   04:22:21.559  tui_turn_ended  T-sweep-8  stop_reason=error -> failed
     *   04:22:21.567  settled         T-sweep-8            <- pass gives up
     *   04:22:21.630  a NEW session   (the `/new` this settle authorised)
     *   04:22:22.673  auto-trigger fires AGAIN for T-sweep-8
     *   04:22:38      the seat writes dispatch-request.json into a dead epoch
     *
     * The work was correct and complete and nobody read it, because the pass
     * that would have read it had closed seventeen seconds earlier. Sweep 9
     * did it too, and would have gone on doing it every cadence forever.
     *
     * **The ordering is the fix, not an optimisation.** `resetPaneSession` is
     * typed by the console only after `awaitSettled` returns, and `awaitSettled`
     * returns on the existence of the record written immediately below. Clearing
     * after that write leaves a window — short, real, and the same shape as the
     * one being closed. Clearing before it makes "the record exists" imply "the
     * drop is idle", which is the property the reset needs and the property
     * `test/unit/dispatch-policy.test.ts` pins by source order.
     *
     * Best-effort, because a settle must not be blocked by a file write: the
     * epoch is over either way and a task that cannot be recorded is a worse
     * failure than a trigger that stays armed. A failure is LOGGED rather than
     * swallowed — the re-fire hazard is back when this line does not run, and
     * an operator reading `events.jsonl` after a duplicated turn needs to find
     * that here rather than deduce it.
     */
    try {
      await clearDispatchPolicy(wp.dispatchPolicy);
    } catch (err) {
      logEvent({
        type: "dispatch_drop_clear_failed",
        task_id: settled.task_id,
        epoch: settled.epoch,
        detail: err instanceof Error ? err.message : String(err),
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
    /**
     * Clear the provenance as the task settles. A worker process outlives its
     * epoch, so anything it runs between settle and the next dispatch belongs
     * to NO task — recording it against the one that just finished would be a
     * false attribution, and a row naming work it did not come from is exactly
     * the failure this file was built to remove.
     */
    await writeTaskPolicy(wp.taskPolicy, null, 0);
    state.task_id = null;
    /**
     * The third and last of `staged_task_id`'s clear sites, and the one that
     * catches the paths the other two do not.
     *
     * The trigger clears it when a turn starts and `unstage` clears it when the
     * epoch is released, which between them cover the two ways a stage is meant
     * to end. This covers every way it is not: a staged epoch settled `failed`
     * on restart, killed by the deadline the trigger armed, or aborted — all of
     * which reach `settle` without passing through either. `stagedDeadlineMs` is
     * cleared eleven lines above for exactly this reason and says so; the id is
     * the same fact in the state file, and clearing one without the other would
     * leave `status` naming a staged task whose parked deadline had already been
     * discarded.
     */
    state.staged_task_id = null;
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
    /**
     * THE `tui` LAUNCH IS NOT A DEATH (spec item 2.0, and the launch-side half
     * of item 6).
     *
     * On the `rpc` path `child` IS the worker: a foreground `docker run` that
     * lives exactly as long as Pi does, which is what makes its exit the
     * unambiguous end of the worker. On the `tui` path `child` is a `docker run
     * -d` CLIENT. It returns as soon as the container has STARTED — measured at
     * a few hundred milliseconds — and Pi then runs for the whole session
     * behind it, attached to a pseudo-TTY this process does not hold.
     *
     * Running the block below on that exit would therefore, within a second of
     * every tui worker starting: write `phase: "dead"`, settle any live epoch
     * `failed:worker_died`, append `worker_exit` to the ledger, and — if a stop
     * were in flight — deregister and `process.exit(0)`. The worker would be
     * alive in Docker and dead in every artifact the fleet reads, which is the
     * quiet-wrongness shape rather than a visible failure.
     *
     * A NON-ZERO exit is still a real failure and is treated as one. `docker
     * run -d` exits 0 when the container was created and started; anything else
     * means it did not, and there is nothing behind it to keep alive. That
     * asymmetry is the whole branch: exit 0 says "handed off", and only exit 0
     * says it.
     *
     * What replaces the exit as the LIVENESS signal is not in this function.
     * `docker inspect` on the recorded name would be the honest probe and is
     * not built here; until it is, a tui worker whose container dies after a
     * successful start is detected by its transcript going quiet, which
     * `settleFromTranscript` treats as the end of the turn. That is coarser
     * than the `rpc` path's guarantee and is said so rather than implied — the
     * mode voids F15 ("closing a pane doesn't stop the worker") for the same
     * underlying reason (SRD §3.5).
     */
    if (tuiMode && code === 0) {
      /**
       * `state.exit` is deliberately NOT written here, and that is the point of
       * the whole branch rather than an omission. That field means "the worker
       * exited, with this code"; `status` prints it and `harvest` reads it. The
       * process that exited was the docker CLI, and recording its 0 there would
       * assert a clean worker shutdown that has not happened.
       */
      logEvent({ type: "tui_launch_returned", code, signal });
      return;
    }
    state.exit = { code, signal };
    state.phase = "dead";
    client?.close("child exited");
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
    /**
     * The completion probe is an RPC probe, so a `tui` worker never reaches it.
     *
     * Not merely "cannot" — `client` is null and every line below dereferences
     * it — but MUST NOT, which is why this reads as its own guard rather than
     * relying on the `?.` that would be needed anyway. The probe's contract is
     * two correlated `get_state` calls under one generation token, and half of
     * that (one call answered, one not) is not a weaker version of the probe,
     * it is a different and wrong one. `settleFromTranscript` is what settles a
     * tui epoch; see there for what it gives up.
     *
     * Nothing feeds `tracker` in this mode either — its inputs are RPC events —
     * so `tracker.eligible` would never be true and this guard is currently
     * belt-and-braces. It is written anyway because a future event source that
     * fed the tracker without a control channel would silently arm a probe that
     * cannot run.
     */
    if (client === null) return;
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
      // `?.` and not a guard: this whole path is driven by an
      // `extension_ui_request` arriving on the RPC event stream, so a `tui`
      // worker has no route to it. SRD §3.5 voids the answering behaviour for
      // that mode — a dialog blocks until a person answers it in the pane,
      // which is acceptable only because the mode is attended.
      client?.sendUncorrelated(cancelledResponse(plan.id));
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
    // `?.` for the same reason as the UI path: `prose` is fed only from the
    // LIVE-attributed branch of `onEvent`, which is the RPC event stream, so a
    // `tui` worker's detector never counts a turn and never trips. The escalation
    // ladder below is left unconditional — if a future event source ever trips
    // the detector without a control channel, the epoch must still come down.
    void client?.send("abort").catch(() => {});
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

  /**
   * THE CONTROL CHANNEL — and its absence (SRD §3.5, spec item 5).
   *
   * `null` for a `tui` worker, and null rather than a client wired to a sink
   * because the difference has to be visible at every call site. There are
   * fourteen `client.` uses in this file and each one is a different question:
   * `prompt` must not be sent (a person types the prompt into the pane),
   * `get_state` cannot be answered, `abort` is replaced by
   * `docker kill --signal=INT`, `export_html` has no route at all. A client
   * that swallowed writes and never answered would turn every one of those into
   * a five-second timeout and a plausible-looking log line; `?.` and explicit
   * `client === null` guards make each site state its own answer.
   *
   * There is nothing to talk TO in any case. `docker run -d` returns as soon as
   * the container starts: this process's `child` is that short-lived client,
   * its stdout carries a container ID and then closes, and Pi's actual stdio is
   * on a pseudo-TTY inside the container that only `docker attach` reaches.
   * Feeding that stdout to `RpcClient` would not fail loudly — it would parse
   * one non-JSON line, report a protocol error, and kill the child.
   */
  const client: RpcClient | null = tuiMode
    ? null
    : new RpcClient(
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
    if (client === null) {
      /**
       * A detached `docker run` prints the container's full 64-hex ID and
       * exits. It is recorded for two reasons, neither of them cosmetic.
       *
       * `state.container.id` is written `""` at startup with a comment saying
       * the ID "is deliberately not guessed: it is unknowable until Docker
       * starts it". On the `rpc` path it stays unknowable, because a foreground
       * `docker run` never prints it. Here Docker hands it over, so the field
       * that has always been empty can hold the true value — and `docker logs`
       * or `docker inspect` on a worker whose NAME was reused now has an
       * unambiguous handle.
       *
       * It is recorded as well as logged because `down` removes by NAME and
       * must keep doing so (ISC-188: two spellings of one container is the
       * defect). This ID is diagnostic, and nothing routes off it.
       */
      const decoder = new TextDecoder();
      let out = "";
      for await (const chunk of child.stdout) out += decoder.decode(chunk as Uint8Array, { stream: true });
      const id = out.trim();
      if (/^[0-9a-f]{12,64}$/.test(id)) {
        if (state.container !== null) state.container.id = id;
        logEvent({ type: "tui_container_started", container_id: id });
        void flushState();
      } else if (id !== "") {
        // Not a container ID. Said out loud rather than dropped: `docker run`
        // writes diagnostics to stderr, so unexpected STDOUT means the argv is
        // not the one this branch believes it built.
        logEvent({ type: "tui_container_id_unrecognized", output: id.slice(0, 200) });
      }
      return;
    }
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

  if (client === null) {
    /**
     * THE `tui` IDLE GATE — what stands in for the initial `get_state`.
     *
     * ISC-70's gate is "the RPC stream answered, therefore this worker is
     * dispatchable". That evidence does not exist here, and the honest
     * substitute is the one fact Docker does supply: whether `docker run -d`
     * succeeded. Exit 0 means the container was created AND started; anything
     * else means it did not, and there is no worker.
     *
     * Awaiting it is safe on this path and would NOT be on the other. Here the
     * child is a CLI that returns in a few hundred milliseconds by design; on
     * the `rpc` path the child is Pi itself and awaiting its exit would block
     * the supervisor for the worker's entire life, before the control socket
     * ever served a dispatch.
     *
     * **WHAT THIS GATE DOES NOT CLAIM.** `rpc`'s gate proves Pi is up and
     * answering. This proves Docker started a container. Pi could still fail
     * inside it — a bad `--skill` path, an image without the binary — and this
     * gate would call the worker idle. The failure surfaces one layer later, as
     * a transcript that never appears and a task that settles on its deadline
     * rather than on a refusal. Closing that needs a readiness probe inside the
     * container, which this phase does not build.
     */
    const code = await child.exited;
    state.phase = code === 0 ? "idle" : "dead";
    if (code !== 0) {
      logEvent({ type: "tui_launch_failed", code });
      process.stderr.write(
        `supervisor: docker run -d exited ${code} for ${argv.workerId}; no container was started\n`,
      );
    }
  } else {
    // Initial get_state: records the session path verbatim and proves the RPC
    // stream is live — the idle gate ISC-70 measures.
    try {
      const r = await client.send("get_state", {}, { timeoutMs: 30_000 });
      if (r.response.success) recordSessionPath((r.response.data ?? {}) as RpcSessionState);
      state.phase = "idle";
    } catch {
      state.phase = "dead";
    }
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
      /**
       * SITE 1 of 6 — the DEADLINE abort. A `tui` worker gets none.
       *
       * SRD §3.5 voids RPC `abort` for this mode and names the replacement:
       * `docker kill --signal=INT` against the container. That is spec item 8
       * and it is NOT built here — `.local/TUI-SPEC.md` §2.8 shows why it is a
       * product decision rather than a line of code (tini runs without `-g`, so
       * the signal lands on the entrypoint shell; and the shell's own
       * `trap forward TERM INT HUP` would convert a person's Ctrl-C in the pane
       * into a SIGTERM on the worker). Shipping half of that would give a pane
       * whose Ctrl-C kills the agent.
       *
       * So the deadline is recorded and NOT acted on, loudly. The event is the
       * whole point: a silent `?.` here would leave an operator reading a task
       * that timed out with no line anywhere saying the interrupt never left
       * this process.
       */
      if (client === null) {
        logEvent({
          type: "tui_abort_unavailable",
          trigger: "deadline",
          task_id: em.live.task_id,
          epoch: em.live.epoch,
          detail: "no RPC channel in pane_mode: tui; docker kill --signal=INT is spec item 8",
        });
      } else {
        void client.send("abort").catch(() => {});
      }
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
            //
            // FOR A `tui` WORKER THIS KILL REACHES NOTHING, and saying so is
            // better than letting the line read as a guarantee it no longer
            // makes. `child` is the `docker run -d` CLI, which exited seconds
            // after launch; killing it is a no-op and the container runs on.
            // The epoch is still settled — the task is over as far as the fleet
            // is concerned — but the worker is not stopped. Stopping it needs
            // `docker kill` against the recorded name, which is spec item 8.
            if (tuiMode) {
              logEvent({
                type: "tui_kill_unavailable",
                trigger: "deadline_escalation",
                detail: "the epoch is settled but the container was not stopped (spec item 8)",
              });
              return;
            }
            child.kill();
          });
      }, ABORT_GRACE_MS);
    }
    void flushState();
  }, HEARTBEAT_MS);

  // -------------------------------------------------------------------------
  // The `tui` completion plane (SRD §3.5, spec item 6) — transcript-derived.
  //
  // BELOW the heartbeat, and that position is load-bearing rather than
  // stylistic. `test/unit/supervisor-session-latch.test.ts` locates the
  // heartbeat by matching from the first `setInterval(() => {` to the first
  // `}, HEARTBEAT_MS)` and then asserts what that body may not contain. A
  // second interval declared ABOVE it silently widens that capture to span both
  // — which is how this block first failed the guard, on a body that was not
  // the heartbeat's. The guard is right; it was reading the wrong interval.
  // -------------------------------------------------------------------------

  /** The transcript reader, once a session file has been found. */
  let tuiReader: TranscriptReader | null = null;
  /**
   * The entry count at the moment the LIVE epoch was first observed, and the
   * epoch that count belongs to.
   *
   * Both, because one without the other is wrong. The count alone would carry
   * across an epoch boundary and let the second task on a worker be judged from
   * the first task's entries; the epoch alone says nothing about where to slice.
   */
  let tuiBaselineEpoch: number | null = null;
  let tuiBaselineCount = 0;
  /**
   * WHICH TRANSCRIPT `tuiBaselineCount` COUNTS INTO (ISC-1117).
   *
   * The baseline is an INDEX, and an index is meaningless without the file it
   * indexes. Keyed on the epoch alone it survives a session switch it cannot
   * survive: `slice(10)` against a transcript that has just been replaced reads
   * from the wrong offset of the wrong file, and when the new file is shorter
   * than the index it reads NOTHING — `classifyTuiTurn` sees an empty window,
   * answers `awaiting_start` for ever, and the epoch runs to its deadline with
   * the turn long since finished on disk.
   */
  let tuiBaselinePath: string | null = null;
  /**
   * How long the reading has been `ended`, or null whenever it is not.
   *
   * A `Stopwatch` and not a `Date.now()` subtraction (ISC-155). The quiet
   * window is an ELAPSED measurement, and this supervisor runs on a laptop that
   * sleeps: wall clock jumps on resume, so a two-second window measured against
   * it would elapse instantly the moment the lid opened and settle a turn that
   * was still running. `src/util/clock.ts` states the rule and
   * `test/unit/clock.test.ts` greps this file for violations — it caught this
   * line written the wrong way round.
   */
  let tuiQuiet: Stopwatch | null = null;
  /** Entry count at the previous poll, to detect growth. */
  let tuiLastCount = 0;
  /** Re-entrancy guard: the poll body awaits, the interval does not wait. */
  let tuiPolling = false;
  /**
   * When the session search last ran, so re-discovery is bounded.
   *
   * The search used to run only while `session_path` was null — find it once,
   * keep it for ever. That is correct for a session a worker keeps, and it is
   * exactly wrong for one it is told to replace: `resetPaneSession` types
   * `/new` at an idle pane, Pi starts a session named for its own generated id,
   * and this loop went on polling the previous file until the run ended.
   * Measured on 2026-09-08/09 — a triage seat that had completed a sweep, been
   * reset, and completed another, while `status` reported it frozen at the
   * reset instant and the console's actor failed the pass it had in fact
   * delivered.
   *
   * Re-running on every poll would readdir the run's session directory twice a
   * second for the life of the worker to catch an event that happens between
   * tasks, so it is throttled instead. A reset session is therefore noticed up
   * to `SESSION_REDISCOVER_MS` late, and the entries written in that window are
   * read the moment it is adopted, because `TranscriptReader` starts from the
   * top of a new path.
   *
   * **This paragraph used to end "the cost of the throttle is bounded and
   * uninteresting", and that was false — see ISC-1117.** The entries are read,
   * and then discarded: `tuiBaselineCount` was an index into the file being
   * replaced, so `slice(baseline)` on the new one read from the wrong offset
   * and, when the new file was shorter than the index, read nothing at all. The
   * window is small and what falls into it is a whole task. The baseline is now
   * a `(path, index)` pair and re-bases when the path moves; the throttle is
   * genuinely uninteresting only because of that.
   *
   * A `Stopwatch` and not two `Date.now()` reads, on ISC-155's rule that wall
   * clock may LABEL a record and must never be subtracted to decide anything.
   * `clock.test.ts` greps this file for exactly that and caught the first
   * version of this throttle. The rule earns its keep here specifically: a
   * suspended laptop is an ordinary event on the machine this fleet runs on,
   * and it would make a wall-clock interval jump hours in one poll.
   */
  const tuiDiscoveryAge = new Stopwatch();

  /**
   * Poll the session transcript, and settle the live epoch off it.
   *
   * This is what replaces `maybeProbe` for an attended worker, and it is
   * deliberately a much weaker instrument. `maybeProbe` asks Pi twice, under a
   * correlated generation token, and believes the answer only if both replies
   * agree; there is no one to ask here, so the substitute is to watch the file
   * Pi writes and decide the turn ended when it stops growing after an assistant
   * message that did not end in a tool call. SRD §3.5 says completion in this
   * mode is "transcript-derived, coarser". This is that coarseness, and the
   * places it is coarse are named on `classifyTuiTurn` and `TUI_QUIET_MS`.
   *
   * ## Two jobs, and only one of them waits for Phase 3
   *
   * DISCOVERY runs today and matters today. `state.session_path` is what
   * `harvest`, `transcript` and `budget` read, and SRD §3.5 promises the harvest
   * is IDENTICAL in both modes — which is only true if something records the
   * path. On the rpc path `get_state` reports it; here nothing would, and a
   * `tui` worker's transcript would be invisible to every consumer even though
   * the file was sitting in the run directory. That half is live whether or not
   * a task is ever dispatched, which is the normal case for a worker a person
   * is simply pair-working with.
   *
   * SETTLEMENT cannot fire yet, and that is stated rather than left to be
   * discovered. `dispatch` REFUSES for a tui worker in this phase (see the case
   * below), so no epoch goes live and `em.live` is always null here. Spec item
   * 10 — `pifleet dispatch` routing through `cmux send` — is what makes epochs
   * live by the pane route, and this loop is what will settle them. It is
   * written and unit-proved now because the alternative is Phase 3 landing a
   * dispatch path with no completion path underneath it.
   *
   * ## The baseline is taken HERE and not at dispatch
   *
   * Deliberately, and it is the reason this survives Phase 3 unchanged: the
   * loop snapshots the entry count the first time it SEES a live epoch, so it
   * does not care which route made it live. The cost is a window of up to one
   * `TUI_POLL_MS` in which entries appended between the epoch going live and
   * this poll observing it are counted as pre-baseline and ignored. At 500 ms,
   * against a turn that has to reach a model before it writes anything, that
   * window is not reachable in practice — but it is a real bound and it is
   * written down rather than assumed away.
   */
  const transcriptPoll: ReturnType<typeof setInterval> | null = !tuiMode
    ? null
    : setInterval(() => {
        if (tuiPolling || shuttingDown) return;
        tuiPolling = true;
        void (async () => {
          try {
            if (
              state.session_path === null ||
              tuiDiscoveryAge.elapsedMs() >= SESSION_REDISCOVER_MS
            ) {
              tuiDiscoveryAge.restart();
              /*
               * THE ROSTER IS WHAT AUTHORISES ADOPTION, and it is read here
               * rather than cached at start-up because `workers/` is the run's
               * own record and a supervisor outlives edits to it.
               *
               * `discoverSessionPath` adopts a Pi-generated session only when
               * the caller can say this worker is the run's only one. Handing
               * it the roster is that statement; failing to read it is not an
               * error, it is the ordinary "cannot say", and the search then
               * falls back to the matched path exactly as before.
               */
              let roster: string[] = [];
              try {
                roster = await readdir(run.workersDir);
              } catch {
                roster = [];
              }
              const found = await discoverSessionPath(run.sessionsDir, argv.workerId, roster);
              /*
               * A search that found nothing NEW leaves the recorded path alone.
               *
               * Two shapes reach here and neither is a change: the throttle
               * fired and the same file is still the answer, or the directory
               * momentarily produced nothing while a path is already held. The
               * first is the common case by far and must not write an event or
               * flush state twice a second; the second must not un-record a
               * session over a transient readdir.
               */
              if (found.path !== null && found.path === state.session_path) {
                // UNCHANGED — the common case by far once a path is held, and
                // it must not write an event or flush state twice a second.
                //
                // `found.path !== null` is load-bearing rather than defensive:
                // both sides are null before the first session file exists, and
                // an equality test alone would swallow that case into "nothing
                // changed" and never reach ISC-492's branch below. Measured —
                // the first version of this chain did exactly that and turned
                // `tui-transcript-activity.test.ts` red.
              } else if (found.path === null && state.session_path !== null) {
                // A transient readdir that produced nothing must not UN-record
                // a session already held. Keep it and try again next window.
              } else if (found.path === null) {
                /**
                 * WATCHING, AND HAVE SEEN NOTHING — written here rather than
                 * returned past (ISC-492).
                 *
                 * This early return used to be bare, and the cost was measured
                 * rather than imagined: on 2026-09-02 four of six live attended
                 * workers had carried `transcript_activity: null` for nine hours,
                 * because a `tui` worker's session file is created lazily on its
                 * FIRST ASSISTANT MESSAGE and a worker nobody has typed at yet
                 * has none. `null` is the value an `rpc` worker also carries, so
                 * every surface reading only `state.json` — `pifleet status`
                 * included — rendered the two identically. **A worker that has
                 * never spoken and a worker whose turns do not run here are
                 * different facts, and the field existed to tell them apart.**
                 *
                 * `{entries: 0, last_growth_at: null}` is not a new shape and
                 * needs no schema change: `entries: 0` is already legal, and
                 * `last_growth_at: null` already means MEASURED-AND-NEVER-GREW
                 * rather than not-measured — `contracts.ts` spells that out for
                 * the case of a supervisor started against an existing
                 * transcript. A watcher that has looked and found no file is in
                 * exactly that epistemic position.
                 *
                 * **It does NOT mean the worker is stuck**, and nothing derived
                 * from it may say so. Nothing on disk distinguishes a worker
                 * that has never spoken from one that is wedged; this field
                 * closes the first gap and makes no claim about the second.
                 *
                 * Written once and only on change, matching the flush discipline
                 * the counter write below argues for — a poll that flushed every
                 * tick would turn a 500 ms clock into a 500 ms write.
                 */
                if (state.transcript_activity === null) {
                  state.transcript_activity = { entries: 0, last_growth_at: null };
                  void flushState();
                }
                return;
              } else {
              /**
               * The path, and ONLY the path.
               *
               * `session_present` is deliberately not set here even though the
               * file has just been stat'd by the search. ISC-281 put that latch
               * on the write path — `noteSessionFilePresent` runs inside
               * `flushState`'s chain, immediately before the bytes are
               * serialized — and `supervisor-session-latch.test.ts` asserts
               * there is EXACTLY ONE place that stats the recorded path,
               * because a second one makes the first deletable with every test
               * still green. The `flushState()` below is what sets the flag, on
               * the same code path an rpc worker uses.
               */
              state.session_path = found.path;
              /**
               * A DIFFERENT event type from the rpc path's, on purpose.
               *
               * `session_file_present` says the recorded path exists. This says
               * the path was INFERRED from a filename rather than reported by
               * Pi, and `matches` says how many files the inference had to
               * choose between. An operator reading a run months later should
               * be able to tell which of the two claims they are holding — see
               * `discoverSessionPath` for why the weaker one is the only one
               * available in this mode.
               */
              logEvent({
                type: "tui_session_path_discovered",
                path: found.path,
                matches: found.matches,
                ...(found.adopted ? { adopted: true } : {}),
              });
              void flushState();
              }
            }
            /*
             * Unreachable by the branches above — every path that leaves
             * `session_path` null returns — and asserted rather than cast,
             * because re-discovery made the reasoning long enough to be worth
             * the compiler checking it instead of a reader.
             */
            if (state.session_path === null) return;
            if (tuiReader === null || tuiReader.path !== state.session_path) {
              tuiReader = new TranscriptReader(state.session_path);
              tuiLastCount = 0;
              tuiQuiet = null;
            }
            await tuiReader.poll();
            const count = tuiReader.entries.length;
            const grew = count > tuiLastCount;
            tuiLastCount = count;

            /**
             * ABOVE the `live === null` return, and that placement is the whole
             * fix rather than an ordering preference.
             *
             * Everything below this point is EPOCH work, and an attended pane
             * has no epoch — `dispatch` refuses the socket route for a `tui`
             * worker, so `em.live` is null on every poll of a worker a person
             * is typing into. Recording activity anywhere below the return
             * would therefore record it for exactly the workers that already
             * report their state some other way, and never for the ones that
             * do not. `status` would keep printing `idle` beside a pane
             * mid-turn, which is the defect (`WorkerStateSchema.transcript_activity`).
             *
             * `grew` and not `entries !== count`: a count that went DOWN is a
             * different transcript, not a write, and dating it as growth would
             * report a shrinking file as activity. `last_growth_at` therefore
             * AGES between writes rather than being refreshed, which is what a
             * reader wants from it — the value IS the age.
             *
             * THE FLUSH IS BELT AND BRACES, and that is stated rather than
             * implied. The heartbeat flushes the whole state file every
             * `HEARTBEAT_MS` (250 ms), which is FASTER than this poll's 500 ms,
             * so the field reaches disk with or without the call below —
             * measured, by deleting it and watching the integration probe stay
             * green. It is kept because every other site that mutates `state`
             * flushes at the point of change and treats the heartbeat as a
             * backstop, and a field whose durability depended on a different
             * interval's body would break silently if that body ever became
             * conditional. The guard keeps it to one extra flush per CHANGE
             * rather than one per poll.
             */
            const seen = state.transcript_activity;
            if (seen === null || seen.entries !== count) {
              state.transcript_activity = {
                entries: count,
                last_growth_at: grew ? isoNow() : (seen?.last_growth_at ?? null),
              };
              void flushState();
            }

            /**
             * THE EPOCH GATE — reachable since D6, and STILL DEAD for one of
             * the two `tui` routes. Labelled rather than left to be read as
             * live, in the style `dispatch.ts` uses for its declared-unreachable
             * key loop.
             *
             * Defect B was that everything below this line could never run: the
             * only caller of `em.allocate` was the RPC `dispatch` handler, which
             * refuses a `tui` worker 29 lines before reaching it, and
             * `sendViaPane` never reaches the supervisor at all. So `em.live`
             * was null on every poll of every `tui` worker, `classifyTuiTurn`
             * never ran, no task record was ever written, and `pifleet wait`
             * could only time out. The settle path was not missing; it was
             * waiting for an allocator.
             *
             * The `stage` verb is that allocator, and D12 is the decision to let
             * Defect B close as a CONSEQUENCE of D6 rather than as a separate
             * repair — the alternative, a settle that works without an epoch,
             * would have to invent a second identity for a turn in order to
             * write the task record `wait` reads.
             *
             * **WHICH ROUTE IS NOW LIVE, AND WHICH IS NOT.** `stage` is reached
             * by the ADOPTED-terminal route only. A backend-managed `tui`
             * worker is still dispatched by `sendViaPane` typing into its pane,
             * which allocates nothing, so for that worker `em.live` is still
             * null on every poll and everything below is still dead. That is a
             * known-dead mechanism left in the tree deliberately: it is the same
             * code, correct for both, and backporting the verb to the pane route
             * is what makes it run (§5.3). Nobody should read this gate as
             * covering both routes because it covers one.
             */
            const live = em.live;
            if (live === null) {
              // Nothing to settle. The reader is still polled above so that the
              // baseline taken when an epoch DOES go live reflects the file as
              // it actually stands, rather than as it stood at the last epoch.
              tuiBaselineEpoch = null;
              tuiQuiet = null;
              return;
            }
            /**
             * ── RE-BASE WHEN THE TRANSCRIPT MOVES UNDER A LIVE EPOCH (ISC-1117) ──
             *
             * Two conditions, not one. A new epoch needs a baseline; so does the
             * SAME epoch whose session file has been replaced beneath it, and the
             * second was missing.
             *
             * How it happens is ordinary, not exotic: `resetPaneSession` types
             * `/new` at every settle, so a new session appears between sweeps, and
             * session re-discovery is throttled to `SESSION_REDISCOVER_MS`. A
             * stage landing inside that window takes its baseline against the
             * OUTGOING file and is then pointed at the incoming one.
             *
             * Measured on run `2026-09-09T05-21-27Z-6767`, and both directions
             * appear in the same events file:
             *
             *   05:38:38  tui_turn_baseline  T-sweep-11  entries_before: 10
             *             ...taken on `..._tri-1.jsonl`, which had 11 entries
             *   05:38:45  tui_session_path_discovered -> `..._01a0849e-….jsonl`
             *             ...a file four entries long
             *   06:03:45  deadline_exceeded            <- 25 minutes
             *
             *   06:06:38  tui_turn_baseline  T-sweep-12  entries_before: 11
             *             ...taken on the file it then read
             *   06:07:00  tui_turn_ended               <- 22 seconds, success
             *
             * The turn itself was fine both times. `tri-1` had written its
             * fan-out and its result within twenty seconds of each trigger.
             *
             * **The re-base is to ZERO, and that is not a shortcut.** An adopted
             * session is one `discoverSessionPath` accepted, which requires a
             * Pi-generated name and a sole-worker roster (ISC-1112) — such a file
             * is created by the `/new` this console types at the PREVIOUS settle,
             * so every entry in it postdates that settle and belongs to the live
             * epoch. Re-basing to `count` instead would discard exactly the
             * entries the switch was late for, which is this same defect with a
             * smaller window.
             */
            const transcriptMoved =
              tuiBaselinePath !== null && tuiBaselinePath !== state.session_path;
            if (tuiBaselineEpoch !== live.epoch || transcriptMoved) {
              const newEpoch = tuiBaselineEpoch !== live.epoch;
              tuiBaselineEpoch = live.epoch;
              tuiBaselinePath = state.session_path;
              tuiBaselineCount = newEpoch ? count : 0;
              tuiQuiet = null;
              logEvent({
                type: "tui_turn_baseline",
                epoch: live.epoch,
                task_id: live.task_id,
                entries_before: tuiBaselineCount,
                ...(newEpoch
                  ? {}
                  : {
                      rebased_onto: state.session_path,
                      detail:
                        "the session file was replaced under a live epoch; the previous " +
                        "baseline indexed a transcript this worker no longer reads (ISC-1117)",
                    }),
              });
              return;
            }

            /**
             * THE TRIGGER, AND IT IS APPROXIMATE — the word is §9 Q1's and it
             * is used here deliberately rather than softened.
             *
             * A staged epoch's deadline must start when the turn starts, and
             * the supervisor has exactly one observable for that: the
             * transcript growing. So the first growth AFTER the stage's
             * baseline arms the clock.
             *
             * **What Q1 states cannot be separated, and this code does not
             * separate it:** growth after a stage may be the staged task, or it
             * may be the operator's own unrelated prompt typed into the same
             * pane. Nothing in the transcript distinguishes them — the staged
             * brief is a file the operator pastes or references, not a marker
             * Pi records — so an operator who stages a task and then asks the
             * agent something else has started this task's deadline against
             * that other turn. The measurement is therefore an UPPER BOUND on
             * how long the staged task has been running, never an equality, and
             * a `timed_out` verdict produced by it says "the worker has been
             * busy this long since the stage", not "this task ran this long".
             *
             * That inaccuracy was accepted because both alternatives are worse:
             * starting at stage time is wrong by however long the operator
             * takes to press the key, which is unbounded and always in the
             * fatal direction, and never starting a deadline at all hands the
             * fleet a task that can hang forever with no verdict.
             *
             * `grew` and not `count !== tuiBaselineCount`: a transcript that
             * SHRANK is a different file, not a turn, and arming on it would
             * start the clock on a reader reset.
             *
             * ## This is also where the STAGE is PROMOTED, and for the same
             * reason and with the same caveat
             *
             * `handleStage` leaves `phase: "idle"` with the id in
             * `state.staged_task_id`, because at stage time nothing had started
             * and writing `busy` would have been a liveness claim no
             * observation supported (see that function). This tick is the first
             * moment any observation supports one — the transcript grew, so
             * SOMETHING is being written — so `phase` becomes `busy` and
             * `staged_task_id` is cleared, and the two happen together because
             * a worker that is both `busy` and holding a staged id reads as
             * two tasks.
             *
             * The promotion inherits the approximation verbatim: the growth may
             * be the staged task or the operator's own unrelated prompt, so
             * `busy` here means "this worker is mid-turn", which is true either
             * way, and NOT "the staged task is running", which is the stronger
             * claim nothing on this route can make. Clearing `staged_task_id`
             * on an operator's unrelated turn is the cost, and it is the right
             * direction of error: the staged brief is still on disk at
             * `/policy/dispatch` and the epoch is still live and still
             * settleable, so what is lost is the console's "awaiting a
             * keypress" annotation, not the task. Keeping the id instead would
             * leave `status` telling an operator to press a key on a worker
             * that is already typing.
             */
            if (stagedDeadlineMs !== null && grew) {
              deadline.restart();
              deadlineMs = stagedDeadlineMs;
              stagedDeadlineMs = null;
              state.phase = "busy";
              state.staged_task_id = null;
              // AWAITED, unlike the `void flushState()` on the session-path
              // discovery above: that one re-runs on the next tick if it is
              // lost, and this one does not — `stagedDeadlineMs` has already
              // been consumed, so a dropped write leaves `state.json` claiming
              // a staged task forever and there is no second trigger to correct
              // it. The await also puts a rejection inside this poll's own
              // catch instead of leaving it unhandled.
              await flushState();
              /*
               * §9 Q1, answered for one of the two routes (§9 Q4).
               *
               * The detail string below has always said APPROXIMATE, and on the
               * typed route it still must: nothing separates the staged task's
               * turn from an unrelated prompt the operator typed into the same
               * pane. The AUTO-TRIGGER route does separate them, because the
               * message that starts the turn was written by pifleet and carries
               * a string a person would have to type deliberately.
               *
               * Two different sentences rather than one hedged sentence: an
               * operator reading `APPROXIMATE` on a run where the attribution
               * was in fact positive would go and re-derive it by hand, and one
               * reading a confident sentence on a run where it was not would
               * trust a `timed_out` verdict that is only an upper bound. The
               * event is the only place either fact is recorded.
               */
              const attributed = attributedToStage(tuiReader.entries.slice(tuiBaselineCount));
              logEvent({
                type: "tui_stage_triggered",
                epoch: live.epoch,
                task_id: live.task_id,
                deadline_ms: deadlineMs,
                attributed_to_stage: attributed,
                detail: attributed
                  ? "deadline armed on the auto-trigger's own message, which pifleet wrote and " +
                    "no one typed; the growth IS this stage's turn (SRD-TUI-DISPATCH §9 Q4 " +
                    "closes §9 Q1 for this route)"
                  : "deadline armed on first transcript growth after the stage; APPROXIMATE — " +
                    "growth cannot be attributed to the staged task rather than to the " +
                    "operator's own prompt (SRD-TUI-DISPATCH §9 Q1)",
              });
            }

            const sinceDispatch = tuiReader.entries.slice(tuiBaselineCount);

            /**
             * ISC-1126, and it is ABOVE the `ended` gate rather than beside the
             * verdict chain below, which is the only placement that works.
             *
             * A seat stuck in a tool loop is mid-tool-call on every poll, so
             * `classifyTuiTurn` answers `in_flight` for ever and the next four
             * lines return. Everything after them — the quiet window, the
             * precedence chain, `settle` — is unreachable for this failure by
             * construction. That is why no guard this fleet already owned could
             * see it, and a detector wired one block lower would have been
             * complete, tested and dead.
             *
             * It settles `failed` rather than asking the agent to stop: the rpc
             * path's escalation writes to a control channel a `tui` seat does
             * not have, and an epoch whose seat has stopped being able to stop
             * has not succeeded on any reading. The measured alternative is the
             * one this replaces — 480 s to `deadline_exceeded_no_terminal_event`
             * with no artifact, a diagnosis that names the clock instead of the
             * cause.
             */
            const loop = readToolLoop(sinceDispatch);
            if (isToolLoop(loop)) {
              logEvent({
                type: "tui_tool_loop_detected",
                epoch: live.epoch,
                task_id: live.task_id,
                streak: loop.streak,
                call: loop.call,
                detail:
                  `the seat repeated one tool call ${loop.streak} times in a row without ` +
                  `varying it; settling ${TOOL_LOOP_REASON} rather than letting the epoch ` +
                  `run to a deadline that would name the clock instead of the cause ` +
                  `(ISC-1126)`,
              });
              tuiQuiet = null;
              await settle("failed", TOOL_LOOP_REASON);
              return;
            }

            const reading = classifyTuiTurn(sinceDispatch);
            if (reading.phase !== "ended") {
              tuiQuiet = null;
              return;
            }
            // Growth RESETS the quiet clock even when the reading is already
            // `ended`: entries that landed this tick mean the file is still
            // being written, and an ending stop reason observed in the same
            // poll as new bytes is exactly the mid-write race the window
            // exists to survive.
            if (grew || tuiQuiet === null) {
              tuiQuiet = new Stopwatch();
              return;
            }
            // An `error` stop waits longer than any other, because it is the one
            // reading Pi can leave on its own: it retries, and a retry that
            // produces a single entry resets this clock and clears the reading.
            // `TUI_ERROR_GRACE_MS` carries the run that proved it.
            const quietNeededMs = quietWindowMsFor(reading.stopReason);
            if (tuiQuiet.elapsedMs() < quietNeededMs) return;

            /**
             * PRECEDENCE, and it is the rpc path's with one addition.
             *
             * `maybeProbe` orders prose-trip, then `timed_out`, then `aborted`,
             * then `success`, and states the rule behind that ordering: a
             * DIAGNOSIS outranks a DESCRIPTION of how the epoch ended. The
             * prose detector cannot trip here — it is fed from RPC events — so
             * its slot is taken by the one diagnosis this mode does have. A
             * transcript whose last assistant message stopped on `error` says
             * WHY the turn ended, where `timed_out` and `aborted` only say that
             * the supervisor was waiting or had asked it to stop.
             *
             * Everything below `error` is the same chain in the same order, so
             * a task that hit its deadline reads `timed_out` in both modes.
             */
            let verdict: Verdict;
            let reason: string;
            if (reading.stopReason === "error") {
              ({ verdict, reason } = verdictForStopReason("error"));
            } else if (em.timedOut) {
              verdict = "timed_out";
              reason = "transcript_quiesced";
            } else if (em.abortRequested) {
              verdict = "aborted";
              reason = "transcript_quiesced";
            } else {
              ({ verdict, reason } = verdictForStopReason(reading.stopReason));
            }
            logEvent({
              type: "tui_turn_ended",
              epoch: live.epoch,
              task_id: live.task_id,
              stop_reason: reading.stopReason,
              quiet_ms: quietNeededMs,
              verdict,
            });
            tuiQuiet = null;
            // Through `settle`, and not through a second settlement path of its
            // own: that one function writes the fence, the task record, the
            // quiesce sample, the ledger row and `state`, and a tui epoch that
            // settled by any other route would produce a differently-shaped run
            // directory for the same event.
            await settle(verdict, reason);
          } catch (err) {
            // A transcript that cannot be read must not take the supervisor
            // down, and must not be silent either. The next poll retries.
            logEvent({ type: "tui_transcript_poll_failed", message: String(err) });
          } finally {
            tuiPolling = false;
          }
        })();
      }, TUI_POLL_MS);

  /**
   * The closure `stage` and `unstage` are allowed to reach, assembled per call.
   *
   * A FUNCTION DECLARATION and not a `const`, for the same reason
   * `startControlServer` is one: the server is started at the top of `main`,
   * long before this line is reached, so a message arriving in between would
   * find a `const` in its temporal dead zone and take the socket down with a
   * `ReferenceError` instead of answering. Hoisting removes the window rather
   * than making it small.
   *
   * Assembled per call rather than captured once because `state` is mutated in
   * place and `shuttingDown` is read at the moment the verb runs; a snapshot
   * taken at startup would answer with the flags the supervisor had before it
   * ever did anything.
   *
   * **`client` is not in it, and that is the point** — see `StageDeps`.
   */
  function stageDeps(): StageDeps {
    return {
      em,
      state,
      worker: argv.workerId,
      persistFence,
      flushState,
      writeProvenance: (taskId, epoch) => writeTaskPolicy(wp.taskPolicy, taskId, epoch),
      clearDispatchDrop: () => clearDispatchPolicy(wp.dispatchPolicy),
      ledgerAppend: (event, fields) => ledger.append(event, fields),
      logEvent,
      armDeadlineOnTrigger: (ms) => {
        stagedDeadlineMs = ms;
      },
    };
  }

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

        /**
         * SITE 2 of 6 — THE `prompt` SEND, and the one that matters most.
         *
         * A `tui` worker is not dispatchable over this socket. SRD §3.5 gives
         * the mode a different dispatch path entirely — `cmux send` plus
         * `send-key enter`, typed into the pane a person is attached to — and
         * that path is spec item 10, Phase 3. It does not exist yet.
         *
         * ## Why this REFUSES rather than accepting and skipping the send
         *
         * The tempting shape is to allocate the epoch, do everything except the
         * RPC `prompt`, and answer `accepted: true` so that Phase 3's CLI can
         * deliver the text itself. That is the right END state and the wrong
         * state to be in TODAY, because today's `dispatch` CLI reads
         * `accepted: true` as "the worker has the prompt". It would then wait on
         * a task no worker was ever told about, until the deadline settled it
         * `timed_out` — a fleet that looks alive and does nothing, which is the
         * exact shape this repo keeps closing.
         *
         * Refusing BEFORE `em.allocate` is also why nothing is burned. An epoch
         * allocated and then abandoned advances the fence, and `allocate`
         * refuses while one is live, so the tidy-looking alternative of
         * allocate-then-settle would strand the worker for the length of a
         * settle on every attempt. Nothing above this line has touched the
         * fence, `state`, or the task policy.
         *
         * BOTH channels are told, deliberately. The ledger entry is what an
         * operator reads afterwards; the returned error is what the caller sees
         * NOW. A refusal that only logged would be a `dispatch` that appeared to
         * hang from the CLI's side.
         */
        if (client === null) {
          // `client === null` and not `tuiMode`, though the two are equivalent
          // by construction. This spelling is the one that makes the guard
          // real rather than asserted: it is what narrows `client` for the
          // `send` below, so the refusal cannot be deleted without the prompt
          // send failing to compile.
          const reason = "pane_mode_tui_has_no_rpc_dispatch";
          logEvent({
            type: "dispatch_refused",
            task_id: envelope.task_id,
            reason,
            detail:
              "a tui worker is prompted by a person in its pane (cmux send + send-key enter); " +
              "that route is spec item 10 and is not built",
          });
          await ledger.append("dispatch_rejected", {
            worker: argv.workerId,
            task_id: envelope.task_id,
            detail: { reason },
          });
          return {
            accepted: false,
            reason,
            error:
              `worker ${argv.workerId} is pane_mode: tui; the supervisor holds no RPC channel to ` +
              `it and cannot deliver a prompt. Type it in the attached pane.`,
          };
        }

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
        /**
         * Provenance BEFORE the prompt, for the same reason the fence is
         * durable before the prompt: the worker can invoke a gated verb the
         * instant it is prompted, and a verb classified before this write
         * would be ledgered against the PREVIOUS task. The ordering is the
         * whole correctness argument here — the write itself is trivial.
         */
        await writeTaskPolicy(wp.taskPolicy, envelope.task_id, decision.epoch);
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

        /*
         * `decision.epoch`, NOT `envelope.epoch`, and the difference is the
         * whole point of this line.
         *
         * The epoch a task actually runs under is allocated HERE, by the
         * supervisor, and it is what goes on the wire one line below
         * (`epoch: decision.epoch`) and what the harvester validates the
         * result envelope against. `envelope.epoch` is whatever the CALLER put
         * on the task envelope, which for every `dispatch` is the schema
         * default of 0.
         *
         * MEASURED 2026-08-30, on the first live ticketing run after ISC-367
         * put these identifiers in the prompt. The prompt said `epoch: 0`, the
         * worker did exactly as it was told and wrote `"epoch": 0` into its
         * result envelope, and the harvest REFUSED it — "envelope epoch 0 is
         * stale (expected 1)" — clamping a task that had produced a correct,
         * well-formed, fully-paged answer to `verdict=unknown`.
         *
         * This is ISC-367's own lesson landing on ISC-367: the repair for an
         * unbindable placeholder is the VALUE, and a value that is delivered
         * but WRONG is worse than one that is missing, because the worker has
         * no way to doubt it. A missing epoch produced no envelope; a wrong one
         * produces a refused envelope, which degrades the harvest where the
         * absence did not.
         */
        const message = renderPrompt({ ...envelope, epoch: decision.epoch });
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

      /**
       * `stage` — allocate an epoch for a dispatch this supervisor will not
       * deliver (SRD-TUI-DISPATCH D6).
       *
       * ## Why a new verb rather than relaxing `dispatch`'s refusal
       *
       * `dispatch` refuses `client === null` BEFORE `em.allocate`, and the
       * comment on that guard says the spelling is what narrows `client` for
       * the `send` below — delete the guard and the prompt send fails to
       * compile. That is a good guard and it keeps working, untouched, exactly
       * as it is. What it was conflating is DELIVERY with ALLOCATION: the
       * supervisor holds `em`, persists `fence.json` and polls the transcript
       * for a `tui` worker, and none of that needs an RPC channel. The refusal
       * is about delivery, and it currently reads as being about allocation
       * only because on that route the two were the same act.
       *
       * So the concerns are separated at the TYPE level rather than by comment:
       * `handleStage` is a module-scope function whose dependency object has no
       * `client` field and whose scope has no `client` binding, so the mutation
       * this design has to survive — a `stage` that grows a `send` — does not
       * compile for want of a NAME rather than for want of a null check.
       *
       * ## The wire shape is `dispatch`'s, and that is not an accident
       *
       * Same `envelope` / `attempt_id` / `requested_epoch` in, the allocator's
       * own `reason` out. A staged dispatch is dedup'd on `(task_id,
       * attempt_id)` by the same allocator against the same durable `attempts`
       * map, so a re-stage REPLAYS — which is the whole of what §6.3 claims the
       * epoch fences on this route, and is worth nothing if the caller has to
       * speak a second dialect to get it.
       */
      case "stage": {
        const envelope = TaskEnvelopeSchema.parse(msg["envelope"]);
        const attemptId = typeof msg["attempt_id"] === "string" ? msg["attempt_id"] : "a-unknown";
        const requested = typeof msg["requested_epoch"] === "number" ? msg["requested_epoch"] : null;
        return await handleStage(stageDeps(), envelope, attemptId, requested);
      }

      /**
       * `unstage` — release a staged epoch nobody triggered (§9 Q8).
       *
       * The verb the SRD calls "the first thing an implementer will need": a
       * live epoch takes the worker out of service until something settles it,
       * and on this mode nothing will. The names are REQUIRED and not optional
       * — `EpochManager.cancel` refuses unless they match the live epoch,
       * because a cancel that released "whatever is live" would race a real
       * dispatch and hand back a running turn.
       */
      case "unstage": {
        const taskId = typeof msg["task_id"] === "string" ? msg["task_id"] : "";
        const attemptId = typeof msg["attempt_id"] === "string" ? msg["attempt_id"] : "";
        return await handleUnstage(
          { ...stageDeps(), shuttingDown, disarmStagedDeadline: () => (stagedDeadlineMs = null) },
          taskId,
          attemptId,
        );
      }

      case "steer": {
        if (em.live === null) return { ok: false, error: "no live epoch" };
        /**
         * SITE 3 of 6 — `steer`. Refused, and the refusal is nearly redundant.
         *
         * Steering is mid-turn text sent to a running agent, which in this mode
         * is precisely what the attached pane is FOR: a person types it. So the
         * capability is not lost, it moved to a keyboard, and the honest answer
         * to a socket client asking for it is to say where it went.
         *
         * Nearly redundant because `dispatch` already refused, so no epoch can
         * be live and the guard above returns first. It is written anyway
         * because that will stop being true in Phase 3 — epochs WILL go live by
         * the pane route — and a `steer` case that fell through to a null
         * `client` at that point would be a crash rather than a refusal.
         */
        if (client === null) {
          return {
            ok: false,
            error: `worker ${argv.workerId} is pane_mode: tui; steer it by typing in its pane`,
          };
        }
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
        /**
         * SITE 4 of 6 — `export_html`. Refused for a `tui` worker, FIRST.
         *
         * This is the one voided capability SRD §3.5 does not list, because
         * §3.5 enumerates what the mode costs the CONTROL plane and this is an
         * artifact path. It is voided all the same, for the same single reason:
         * `export_html` is an RPC method, and there is no RPC channel.
         *
         * The loss is small and is already handled. This case exists so that a
         * LIVE worker renders its own transcript — the authority, because it
         * knows record types `harvest/transcript.ts` only models — and
         * `cli/commands/transcript.ts` already prints the refusal on stderr and
         * falls back to its own render. A `tui` worker therefore exports; it
         * exports via the second opinion rather than the first.
         *
         * Placed at the TOP of the case, above the ISC-276 path check, because
         * everything below it has side effects — `mkdir` of `exportsDir`, a
         * staged filename, a sweep timer — and a refusal that first created an
         * empty `exports/` directory and armed a 30-second timer would be
         * leaving litter for an operation that never had a chance of running.
         */
        if (client === null) {
          return {
            ok: false,
            error:
              `worker ${argv.workerId} is pane_mode: tui and has no RPC channel; ` +
              `render the transcript locally from the recorded session path`,
          };
        }
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
        /**
         * SITE 5 of 6 — the OPERATOR's `abort`, and the only one of the six
         * that must not answer `ok: true` in this mode.
         *
         * The lines above have already recorded the intent — `noteAbortRequested`
         * plus a durable fence plus a ledger entry — and they stay, because a
         * person asked for this and the record of the asking is true. What is
         * NOT true is that anything was interrupted. SRD §3.5's replacement is
         * `docker kill --signal=INT` against the container, which is spec item 8
         * and is unresolved for the reason `.local/TUI-SPEC.md` §2.8 measures:
         * tini runs without `-g` so the signal reaches the entrypoint shell and
         * not the worker, and that shell's `trap forward TERM INT HUP` would
         * turn a person's Ctrl-C in the pane into a SIGTERM that KILLS the agent
         * rather than interrupting the turn. Both ends have to move together.
         *
         * `ok: false` is therefore the honest answer and the important one. An
         * `abort` that logged and returned success would tell `pifleet abort`
         * the turn had been interrupted; the operator would stop watching, and
         * the agent would keep running. Reporting the failure sends them to the
         * pane, where Ctrl-C does reach Pi today.
         */
        if (client === null) {
          logEvent({
            type: "tui_abort_unavailable",
            trigger: "operator",
            task_id: em.live.task_id,
            epoch: em.live.epoch,
            detail: "no RPC channel in pane_mode: tui; docker kill --signal=INT is spec item 8",
          });
          return {
            ok: false,
            error:
              `worker ${argv.workerId} is pane_mode: tui; the abort was RECORDED but not ` +
              `delivered — nothing interrupted the turn. Interrupt it in the attached pane.`,
          };
        }
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
    /**
     * SITE 6 of 6 — the SHUTDOWN abort, and the teardown behind it.
     *
     * §13 F3's graceful stop is abort → give the turn a moment to settle → then
     * close stdin, and every step of that assumes a child whose stdin this
     * process holds. A `tui` worker gives it none, so the sequence is not
     * shortened, it is replaced.
     *
     * The grace WAIT is dropped rather than kept. Waiting exists so an
     * in-flight `abort` can produce a terminal event and settle the epoch
     * cleanly; with no channel there is no abort in flight, and the loop would
     * do nothing but delay every stop by two seconds before settling exactly as
     * it settles now. So the epoch is settled directly, with the same verdict
     * and the same reason string the rpc path writes, because it is the same
     * fact: the operator stopped the worker mid-task.
     */
    if (em.live !== null) {
      if (client === null) {
        logEvent({
          type: "tui_abort_unavailable",
          trigger: "shutdown",
          task_id: em.live.task_id,
          epoch: em.live.epoch,
          detail: "no RPC channel in pane_mode: tui; the epoch is settled without interrupting Pi",
        });
        await settle("aborted", "shutdown");
      } else {
        void client.send("abort").catch(() => {});
        const grace = new Stopwatch();
        while (em.live !== null && grace.elapsedMs() < SHUTDOWN_GRACE_MS) {
          await new Promise((r) => setTimeout(r, 25));
        }
        if (em.live !== null) await settle("aborted", "shutdown");
      }
    }
    if (tuiMode) {
      /**
       * THE TAIL `onChildExit` WILL NEVER RUN, done here instead.
       *
       * On the rpc path the lines below hand off: closing stdin ends Pi, Pi
       * exits, `onChildExit` fires and — seeing `shuttingDown` — deregisters,
       * stops the control server, clears the heartbeat and exits 0. Every one
       * of those depends on a child that is still alive to die.
       *
       * A tui supervisor's child died at launch, on purpose, and its
       * `onChildExit` already returned early. Nothing will ever call it again.
       * Without this block `pifleet down` would leave a supervisor process
       * spinning on a 250 ms heartbeat, still registered and still holding its
       * control socket, forever — which is worse than the hang it replaces,
       * because `state.json` would keep looking healthy.
       *
       * **WHAT THIS DOES NOT DO.** It does not stop the CONTAINER. This process
       * has no handle on it — that was the whole point of detaching — and the
       * `docker kill` that would is spec item 8, unresolved for the reason §2.8
       * of the spec measures. `pifleet down` removes by the recorded name and
       * remains the reaper for this mode, as it already is for an orphan the
       * `--rm` flag could not collect.
       */
      logEvent({ type: "tui_shutdown", detail: "the container is left to `down`; see spec item 8" });
      state.phase = "dead";
      await flushState();
      await ledger.append("worker_exit", {
        worker: argv.workerId,
        detail: { code: null, signal: null, pane_mode: "tui" },
      });
      clearUiDeadlines();
      await registryCall(run, { cmd: "deregister_worker", worker: argv.workerId }, { optional: true });
      await server.stop();
      clearInterval(heartbeat);
      if (transcriptPoll !== null) clearInterval(transcriptPoll);
      process.exit(0);
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

// ---------------------------------------------------------------------------
// `stage` / `unstage` — the staged-dispatch verbs (SRD-TUI-DISPATCH D6, Q8)
// ---------------------------------------------------------------------------

/**
 * Everything `handleStage` and `handleUnstage` are allowed to touch — and,
 * far more importantly, everything they are NOT.
 *
 * ## THERE IS NO `client` HERE, AND THAT ABSENCE IS THE DESIGN
 *
 * D6 asks for a verb that allocates an epoch without delivering a prompt, and
 * asks for it to be a NEW verb rather than a relaxation of `dispatch`'s
 * `client === null` refusal, precisely because that refusal is spelled the way
 * it is so deleting it fails to compile. The `stage` verb needs the mirror-image
 * property: it must be impossible for it to grow a `send`.
 *
 * A `case "stage"` written inline inside `startControlServer` would only have
 * `client` typed `RpcClient | null` — so `client.send(...)` would be a
 * strict-null error, which is real but is one narrowing guard away from
 * compiling. These functions live at MODULE scope instead, where `client` is
 * not a name at all and is not a field of this interface, so the mutation the
 * SRD names — "make `stage` fall through to `send`" — is not a guard away from
 * compiling, it is `Cannot find name 'client'`. Threading the RPC channel in
 * here would mean editing this type, which is a change no reviewer can miss.
 *
 * The secondary benefit is why this shape was worth the parameter object:
 * `src/supervisor/index.ts` is one 2000-line `main()` that spawns a process and
 * opens a socket, and `supervisor-tui.test.ts` says in as many words that the
 * risk in it can only be graded structurally. These two functions are the first
 * pieces of the control plane that can be graded BEHAVIOURALLY, at unit speed,
 * against a real `EpochManager`.
 */
export interface StageDeps {
  em: EpochManager;
  state: WorkerState;
  worker: string;
  /** Fail-stop durable fence write. See `persistFence` in `main`. */
  persistFence: () => Promise<void>;
  flushState: () => Promise<void>;
  /**
   * `/policy/task` — the two-line provenance file the verbgate stamps its
   * ledger from. `(null, 0)` is the "no task" spelling `settle` uses.
   *
   * Injected rather than called directly so the ORDER of the writes is
   * observable to a probe. The order is the correctness argument on this route
   * (§6.1) and the write itself is trivial, so the order is the thing worth
   * being able to assert.
   */
  writeProvenance: (taskId: string | null, epoch: number) => Promise<void>;
  /**
   * `/policy/dispatch` — put the drop back to its idle arm (ISC-1115).
   *
   * The fourth durable consequence of a release, and the one `handleUnstage`'s
   * own list of three walked past. It is NOT the cosmetic sibling of
   * `writeProvenance`: the drop is what `dispatch-trigger.ts` polls, and a
   * `staged: true` header outliving its epoch is a loaded trigger that the next
   * Pi session pulls — ISC-1114's mechanism, reached through the other verb that
   * ends an epoch. `settle` calls `clearDispatchPolicy` directly; this route is
   * a `StageDeps` member for `writeProvenance`'s stated reason, so a probe can
   * assert the release actually disarms rather than inferring it.
   */
  clearDispatchDrop: () => Promise<void>;
  ledgerAppend: (
    event: string,
    fields: {
      worker?: string;
      task_id?: string;
      epoch?: number;
      detail?: Record<string, unknown>;
    },
  ) => Promise<void>;
  logEvent: (record: Record<string, unknown>) => void;
  /**
   * Record the staged task's deadline WITHOUT starting it (SRD §9 Q1).
   *
   * The RPC route runs `deadline.restart(); deadlineMs = envelope.deadline_s *
   * 1000` at dispatch, which is correct there because the turn begins in the
   * same millisecond. A staged epoch's turn begins when a person presses a key,
   * so starting the clock here would make a 20-minute task staged before lunch
   * `timed_out` before it began. The supervisor arms it on the trigger instead;
   * see the arming site in the transcript poll for what "the trigger" can
   * actually be observed as, and why that is APPROXIMATE.
   */
  armDeadlineOnTrigger: (deadlineMs: number) => void;
}

/**
 * The `stage` answer, and the refusal arms are the ALLOCATOR's own.
 *
 * `Extract<DispatchDecision, { ok: false }>` rather than a hand-written union:
 * a caller must be able to read `busy` / `already_completed` / `stale_epoch`
 * from a staged dispatch and from an RPC dispatch with the same code, and a
 * second spelling of the allocator's vocabulary would drift the first time one
 * of them gained an arm. `busy` carries `epoch`, which is how a refused stage
 * NAMES the epoch that is holding the worker — the operator's next move is
 * `unstage` against it.
 */
export type StageAnswer =
  | { accepted: true; epoch: number; replayed: boolean }
  | ({ accepted: false } & Extract<DispatchDecision, { ok: false }>);

/** The `unstage` answer: the cancel decision, plus a sentence for a human. */
export type UnstageAnswer =
  | { ok: true; epoch: number }
  | (Extract<CancelDecision, { ok: false }> & { error: string });

/**
 * `stage` — allocate an epoch for a dispatch nothing is going to send (D6).
 *
 * The steps below are §6.1's steps 2, 3 and 4 in §6.1's order, and the order is
 * borrowed verbatim from the RPC route's own argument (the `dispatch` case,
 * "Provenance BEFORE the prompt"):
 *
 *   1. **Allocate.** A second stage while one is pending is refused `busy` by
 *      the allocator itself, so there is no second check here. §6.1 step 2 says
 *      so explicitly, and adding one would be a second spelling of a fact the
 *      allocator already owns.
 *   2. **Persist the fence, durably, BEFORE anything can act under the epoch.**
 *      Allocate-then-crash-then-restart must not re-issue a number.
 *   3. **Write the provenance, BEFORE the worker can run a gated verb under
 *      it.** A verb classified before this write is ledgered against the
 *      PREVIOUS task.
 *
 * **On this route the gap between step 3 and the act is a human's reaction time
 * rather than a few milliseconds** — which makes the ordering easier to get
 * right and very much more expensive to get wrong, because the window in which
 * a wrong `/policy/task` is on disk is now minutes wide and an operator typing
 * in that pane is stamping every gated verb with it.
 *
 * ## What this deliberately does NOT do
 *
 * - **It does not send.** There is nothing to send it on. See `StageDeps`.
 * - **It does not start the deadline.** §9 Q1; see `armDeadlineOnTrigger`.
 * - **It does not write the task drop (`/policy/dispatch`, §6.2).** That file
 *   and its mount are the next phase's, and staging without it means the worker
 *   has the correct provenance and no rendered brief to read — a staged epoch
 *   that is allocated, fenced and ledgered but not yet READABLE. It is called
 *   out here rather than left to be discovered, because the failure it produces
 *   is a triggered turn that runs against the operator's own typing under a
 *   real task id, which the ledger will attribute perfectly and wrongly.
 * - **It does not claim the agent is running. `phase` goes to `idle` and the
 *   staged id goes in `state.staged_task_id` beside it — §6.5's shape.** The
 *   two facts genuinely differ: the worker cannot take another task (the
 *   allocator refuses while an epoch is live) and it is also not doing
 *   anything, because nobody has pressed the key. `phase` states the second and
 *   `staged_task_id` states the first, so neither has to be inferred from the
 *   other.
 *
 *   Writing `busy` here — which an earlier revision did, back when
 *   `WorkerStateSchema` had no such field — would put a liveness claim on disk
 *   that no observation supports, and `status` would report a turn in progress
 *   for however long the operator takes to come back from lunch. That is the
 *   mirror image of the console defect `transcript_activity` exists for: a pane
 *   reporting `idle` about a worker that was visibly mid-turn. Both readings
 *   are wrong in the same way, and only one field can be wrong at a time, so
 *   the promotion to `busy` waits for the trigger — the transcript poll, where
 *   there is at least an APPROXIMATE observation to hang it on (§9 Q1).
 *
 *   `idle` is WRITTEN rather than left as it was found, and the shutdown
 *   carve-out `settle` and `handleUnstage` both make (`shuttingDown ? phase :
 *   "idle"`) is deliberately not copied. Those two run on the way OUT of an
 *   epoch and are reached BY `beginShutdown`, so preserving a `dead` the
 *   shutdown just wrote is the whole point. Nothing routes a shutdown into
 *   `stage`; it is reached only from the control socket, and a worker that has
 *   just been handed a live epoch is idle by construction. Inheriting
 *   `starting` — which is what `initialWorkerState` writes — would leave a
 *   staged worker reported as still coming up.
 */
export async function handleStage(
  deps: StageDeps,
  envelope: TaskEnvelope,
  attemptId: string,
  requestedEpoch: number | null,
): Promise<StageAnswer> {
  const decision = deps.em.allocate(envelope.task_id, attemptId, requestedEpoch);
  if (!decision.ok) {
    await deps.ledgerAppend("stage_rejected", {
      worker: deps.worker,
      task_id: envelope.task_id,
      detail: { reason: decision.reason },
    });
    return { accepted: false, ...decision };
  }
  if (decision.replayed) {
    /**
     * Idempotent re-stage: the original answer, verbatim, and NOTHING is
     * rewritten.
     *
     * Identical to the RPC route's replay arm and identical for the same
     * reason — the caller lost the ack, not the stage — but it matters more
     * here, because §6.3 makes replay the mechanism by which a staged
     * dispatch is fenced at all. Re-persisting or re-stamping the provenance
     * would be writes performed on behalf of a stage that already happened,
     * and the second write is the one that could land while the epoch is
     * mid-turn.
     */
    return { accepted: true, epoch: decision.epoch, replayed: true };
  }

  await deps.persistFence();
  await deps.writeProvenance(envelope.task_id, decision.epoch);
  deps.state.epoch = decision.epoch;
  deps.state.task_id = envelope.task_id;
  deps.state.staged_task_id = envelope.task_id;
  deps.state.phase = "idle";
  await deps.flushState();
  deps.armDeadlineOnTrigger(envelope.deadline_s * 1000);

  deps.logEvent({
    type: "stage_accepted",
    task_id: envelope.task_id,
    epoch: decision.epoch,
    deadline_s: envelope.deadline_s,
    detail: "epoch allocated for a staged dispatch; no prompt was sent",
  });
  await deps.ledgerAppend("stage_accepted", {
    worker: deps.worker,
    task_id: envelope.task_id,
    epoch: decision.epoch,
  });
  return { accepted: true, epoch: decision.epoch, replayed: false };
}

/**
 * `unstage` — release a staged epoch that was never triggered (§9 Q8).
 *
 * `EpochManager.cancel` holds every refusal; this function's own job is the
 * four durable consequences of a successful one, and each is here for a
 * failure it prevents:
 *
 *   1. **Persist the fence.** The release is a fence mutation like any other.
 *      A supervisor that crashed between the cancel and the next stage would
 *      otherwise come back holding a live epoch nobody can trigger — the exact
 *      state this verb exists to leave.
 *   2. **Clear `/policy/task` back to `(null, 0)`.** `settle` does this and
 *      says why: a worker process outlives its epoch, and anything it runs
 *      between the release and the next dispatch belongs to NO task. Leaving
 *      the cancelled task's id on disk is worse here than after a settle,
 *      because the operator is sitting at that terminal and will keep typing —
 *      every gated verb they run would be stamped with a task that never ran.
 *   3. **Disarm `/policy/dispatch`.** The one the original three missed, and
 *      the only one whose cost is not a stale reading: the drop is a TRIGGER
 *      (`docker/pi-extensions/dispatch-trigger.ts` polls it), its dedup lives
 *      in per-session closure state, and an armed header outliving its epoch is
 *      pulled by the next session that starts. Leaving it re-runs a task the
 *      operator explicitly cancelled — see ISC-1114 for the same mechanism
 *      reached through `settle`.
 *   4. **Reset `state`.** `phase`/`task_id`/`epoch` are what `status` prints;
 *      a released worker that still reports `busy` under the cancelled task is
 *      a fleet that looks occupied and is not.
 *
 * `phase` goes to `idle` unless the supervisor is shutting down, matching
 * `settle`: a shutdown has already decided what the phase means and a release
 * must not overwrite that decision with a liveness claim.
 */
export async function handleUnstage(
  deps: StageDeps & { shuttingDown: boolean; disarmStagedDeadline: () => void },
  taskId: string,
  attemptId: string,
): Promise<UnstageAnswer> {
  const decision = deps.em.cancel(taskId, attemptId);
  if (!decision.ok) {
    return { ...decision, error: unstageRefusalMessage(deps.worker, taskId, attemptId, decision) };
  }

  await deps.persistFence();
  await deps.writeProvenance(null, 0);
  /*
   * Best-effort for `settle`'s reason: a release that has already mutated the
   * fence must not be undone by a file write, and the refusal an operator is
   * waiting on must still be returned. Logged rather than swallowed, because
   * "the trigger is still armed" and "the trigger was disarmed" must not
   * produce identical output — that equivalence is what let ISC-1114 run for
   * months behind a docblock asserting the opposite.
   */
  try {
    await deps.clearDispatchDrop();
  } catch (err) {
    deps.logEvent({
      type: "dispatch_drop_clear_failed",
      task_id: taskId,
      detail: err instanceof Error ? err.message : String(err),
    });
  }
  deps.disarmStagedDeadline();
  deps.state.epoch = 0;
  deps.state.task_id = null;
  // The staged id dies with the epoch it named. Left behind it would be the
  // worst of the three stale readings: `status` would report a worker awaiting
  // a keypress for a task whose epoch has been released, so the operator's
  // remedy — press the key — is one nothing can act on any more.
  deps.state.staged_task_id = null;
  deps.state.phase = deps.shuttingDown ? deps.state.phase : "idle";
  await deps.flushState();

  deps.logEvent({
    type: "stage_cancelled",
    task_id: taskId,
    epoch: decision.epoch,
    detail: "staged epoch released; it never ran, so nothing was settled",
  });
  await deps.ledgerAppend("stage_cancelled", {
    worker: deps.worker,
    task_id: taskId,
    epoch: decision.epoch,
  });
  return { ok: true, epoch: decision.epoch };
}

/**
 * One sentence per refusal, naming the fact AND the remedy.
 *
 * Each arm sends the operator somewhere different, and a shared "cancel
 * refused" would send all three to the same place: `no_live_epoch` means there
 * is nothing to release, `not_the_live_attempt` means they are holding a stale
 * view of the fence, and `already_started` means the turn is RUNNING and the
 * verb they want is `abort` — which on this mode has its own honest refusal to
 * deliver.
 */
function unstageRefusalMessage(
  worker: string,
  taskId: string,
  attemptId: string,
  decision: Extract<CancelDecision, { ok: false }>,
): string {
  switch (decision.reason) {
    case "no_live_epoch":
      return `worker ${worker} has no live epoch; there is nothing staged to release`;
    case "not_the_live_attempt":
      return (
        `worker ${worker} holds epoch ${decision.live.epoch} for ` +
        `(${decision.live.task_id}, ${decision.live.attempt_id}), not ` +
        `(${taskId}, ${attemptId}); re-read the fence before cancelling`
      );
    case "already_started":
      return (
        `epoch ${decision.epoch} on worker ${worker} has already started; a running turn is ` +
        `aborted, not unstaged`
      );
  }
}

/**
 * The worker's prompt, and the two identifiers it could not previously see.
 *
 * ISC-349 found a ticketing worker writing its output to
 * `/outbox/list-tickets-2026-08-29/` — a slug of the job it thought it had
 * done — while the id it was dispatched under was `my-iteration-2`. Both
 * shipped documents already told it to use `<task-id>`. The finding was not
 * the worker's carelessness: **the placeholder was unbindable.**
 *
 * This function took `title`, `brief` and `acceptance` and nothing else, so
 * `task_id` and `outbox` sat in the envelope, reached the supervisor, and
 * never reached the agent. `PIFLEET_TASK_ID` was set nowhere in production
 * (fixed for the verbgate's ledger by ISC-362, which delivers it to the GATE
 * and not to the agent). And `materialize.ts` creates only the worker-level
 * directory that becomes the `/outbox` mount, so the name could not be
 * discovered by listing either. A worker asked for `<outbox>/<task-id>/` had
 * no route to the middle component by any means available to it.
 *
 * Delivering them is the mechanism the instruction was missing. It does not
 * make a worker obey — nothing here can — but it removes the case where
 * obedience was impossible, which is what ISC-349 actually measured.
 *
 * The identifiers go in a fenced block under a heading rather than into the
 * prose, so a model skimming for the task cannot read them as part of the
 * brief's argument, and `outbox` is given as the literal path the worker
 * should write to rather than as a template it has to assemble.
 */
export function renderPrompt(envelope: {
  title: string;
  brief: string;
  acceptance: string[];
  task_id: string;
  outbox: string;
  worker: string;
  epoch: number;
}): string {
  const acceptance =
    envelope.acceptance.length > 0
      ? `\n\n## Acceptance\n${envelope.acceptance.map((a) => `- ${a}`).join("\n")}`
      : "";
  /**
   * DELIVERY ONLY. An earlier version of this block also told the worker to
   * write `<outbox>/result.json` LAST — and the live chain (ISC-290) went from
   * `complete` to `partial` on it, because a worker that previously wrote NO
   * envelope started writing a malformed one, and a refused envelope degrades
   * the harvest where a missing one does not.
   *
   * That was the criterion's own lesson applied backwards. ISC-349's finding is
   * that the placeholder was UNBINDABLE, and the repair for that is the value,
   * not another imperative. `skills/pifleet-worker/SKILL.md` is mounted into
   * every container and already says what to write, where, in what order, and
   * what the envelope must contain; a terser second copy in the prompt competes
   * with it and adds nothing the worker did not already have.
   *
   * So this names the two values and says which placeholders they bind. It
   * changes what the worker CAN do, not what it is told to do.
   */
  const identity =
    `\n\n## This task\n\n` +
    "```\n" +
    `task_id: ${envelope.task_id}\n` +
    `outbox:  ${envelope.outbox}\n` +
    `worker:  ${envelope.worker}\n` +
    `epoch:   ${envelope.epoch}\n` +
    "```\n\n" +
    `These are the values the mounted documents refer to as \`<task-id>\` and \`<outbox>\`, ` +
    `and the ones the ticket-ops artifact schema requires as \`worker\` and \`epoch\`. ` +
    `None is derivable from the title.`;
  return `# ${envelope.title}\n\n${envelope.brief}${acceptance}${identity}`;
}

if (import.meta.main) {
  await main();
}
