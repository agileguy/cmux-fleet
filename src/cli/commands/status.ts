import type { Command } from "commander";
import { readdir } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT, type WorkerPhase, type WorkerState } from "../../contracts.ts";
import {
  latestRunId,
  runPaths,
  runsRoot,
  workerPaths,
  type RunPaths,
} from "../../run/paths.ts";
import { readRunBudgetPolicy, readWorkerState } from "../../run/state.ts";
import {
  identityAlive,
  latestLiveRunId,
  liveRunIds,
  processStartTime,
  readRegistry,
} from "../../run/registry.ts";

/**
 * How long ago, in the coarsest unit that still says something.
 *
 * Seconds under a minute, minutes under an hour, hours above it. An operator
 * glancing at a pane needs to tell `3s` from `40m`, and never needs to tell
 * `181s` from `184s`.
 *
 * WALL CLOCK, deliberately, and this is the one place in the tree that
 * subtracts two of them. `src/util/clock.ts` bans that for anything that
 * DECIDES — a deadline computed across a host suspend fires on the lid
 * opening. This decides nothing: the timestamp was written by a different
 * process, so there is no monotonic origin the two share, and the failure mode
 * of a clock step here is a status line that reads wrong until the next poll.
 * The alternative — printing the raw ISO stamp and making the reader subtract
 * — moves the same arithmetic into the reader's head and loses the glance.
 *
 * A stamp in the FUTURE clamps to `0s` rather than rendering a negative age:
 * a supervisor whose host clock is a few seconds ahead is a skew, and `-3s`
 * reads as a bug in pifleet.
 *
 * `null` for a stamp that will not parse — a truncated or hand-edited state
 * file. The caller says so in words; what must not happen is `NaNs ago`
 * reaching a pane, which reads as a crash rather than as a bad value.
 */
export function ago(iso: string, nowMs: number): string | null {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return coarseDuration(nowMs - then);
}

/**
 * `ago`'s unit rules, without the parsing — extracted so the wedge alarm below
 * can render a span it computed rather than a stamp it read.
 *
 * One implementation, deliberately. Two would drift, and the drift would be
 * invisible: `41m` from one and `41 minutes` from the other on the same status
 * line reads as two different measurements of two different things.
 */
function coarseDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1_000));
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3_600)}h`;
}

/**
 * What to say about a worker's transcript, or nothing at all.
 *
 * The three returns are three different facts and the point of the function is
 * that they never collapse into each other:
 *
 * - `null` — NOT MEASURED. An `rpc` worker, whose `phase` is already the
 *   honest answer, or a `tui` worker before its first poll. The caller prints
 *   nothing, because a worker that reports its state properly should not be
 *   annotated with a column about a mechanism it does not use.
 * - `no writes yet` — measured, and the file has not grown since this
 *   supervisor started watching it. Distinct from the above: something IS
 *   watching, and it has seen nothing.
 * - `3s ago` — measured, and moving.
 *
 * A fourth case exists and is a corruption rather than a state: a stamp that
 * will not parse. It is reported as unreadable rather than aged, because a
 * pane that prints an age is making a claim about when something happened.
 *
 * See `WorkerStateSchema.transcript_activity` for why this exists: for a pane
 * a person types into, `phase` is permanently `idle` and true, and this is the
 * only field that distinguishes a worker mid-turn from one sitting at a
 * prompt.
 */
export function transcriptNote(
  activity: WorkerState["transcript_activity"],
  nowMs: number,
): string | null {
  if (activity === null) return null;
  if (activity.last_growth_at === null) return "transcript no writes yet";
  const age = ago(activity.last_growth_at, nowMs);
  return age === null ? "transcript last write unreadable" : `transcript ${age} ago`;
}

// ---------------------------------------------------------------------------
// The wedged seat — busy, heartbeating, and nothing behind it
//
// A NOTE ON THE PROSE BELOW, in the style `reaper.ts` uses for the same reason:
// this file may now NAME the container runtime's CLI, and the docblocks below
// that say `run -d`, `ps -a` and `inspect` mean exactly those subcommands.
// That was not always safe, and the reason it is safe now is worth keeping.
// `monitor-density.test.ts` pins the claim that `status` never shells out by
// scanning this source for the name, and it used to scan RAW text: documenting
// why a container fact is absent here tripped a guard whose property was still
// true, so the file's working lesson became *avoid a word* rather than *avoid a
// call*, and the guard could equally have been satisfied by deleting the prose
// instead of the call. It now reads comment-stripped source
// (`test/support/source-structure.ts`), so it is satisfied only by code and
// broken only by code. Explain freely — the guard watches what its name says.
// ---------------------------------------------------------------------------

/**
 * The fleet's own opinion about how long silence is too long, in milliseconds.
 *
 * `stall.event_stall_warn` / `event_stall_kill` from `fleet.yaml`, carried into
 * `run.json` by `runBudgetRecord` and read back by `readRunBudgetPolicy`. It is
 * BORROWED and never defaulted here: a status line that invented a threshold
 * would be a second opinion about the same question, and the first thing an
 * operator does when the two disagree is stop believing both.
 */
export interface StallWindow {
  readonly warnMs: number;
  readonly killMs: number;
}

/** Every reason this rule can decline to answer. None of them is an alarm. */
export type SilenceUnknown =
  | "no_activity_record"
  | "no_growth_yet"
  | "no_window"
  | "unreadable_stamp";

/**
 * What `status` can say about a busy worker's silence.
 *
 * The five verdicts are five different facts and the point of the type is that
 * they never collapse into each other — the same discipline `transcriptNote`
 * keeps three facts apart with, and `ReapReport.container` keeps five:
 *
 * - `not_applicable` — nothing here claims to be running a task, or the
 *   supervisor is gone. There is no question to answer.
 * - `unknown` — there IS a question and this rule cannot answer it. `why` says
 *   which of the four ways, because "I have no threshold" and "this worker has
 *   never spoken" want different things done about them.
 * - `working` / `quiet` / `wedged` — answered, in the fleet's own bands.
 */
export type SilenceReading =
  | { readonly verdict: "not_applicable" }
  | { readonly verdict: "unknown"; readonly why: SilenceUnknown }
  | { readonly verdict: "working" | "quiet" | "wedged"; readonly silentMs: number };

export interface SilenceInput {
  /** `null` when `state.json` could not be read at all. */
  readonly phase: WorkerPhase | null;
  /** The `(pid, start-time)` identity check the snapshot already performs. */
  readonly supervisorAlive: boolean;
  readonly heartbeatAt: string | null;
  readonly activity: WorkerState["transcript_activity"];
  readonly window: StallWindow | null;
}

/**
 * Tell a worker that is BUSY AND WORKING from one that is BUSY AND WEDGED.
 *
 * ## The defect
 *
 * Aborting a task can leave a worker whose `state.json` says `phase: "busy"`,
 * whose `heartbeat_at` is rewritten every 250 ms, and whose container is gone
 * from the runtime entirely — absent even from a listing that includes stopped
 * ones. The seat reads as working. There is nothing in it, and until this
 * function existed no field on the status line said so; every one of them was
 * individually true.
 *
 * ## Why nothing upstream catches it
 *
 * `supervisor/index.ts:1109-1143` states the asymmetry that causes it. On the
 * `rpc` path `child` IS the worker, so a container that dies takes the child
 * with it and `onChildExit` writes `phase: "dead"`. On the `tui` path `child`
 * is a detached `run -d` CLIENT that returned a few hundred milliseconds after
 * launch, and the supervisor holds no handle on the container at all. That
 * docblock names an `inspect` on the recorded container name as the honest
 * probe, records that it is NOT built, and nominates the transcript going quiet
 * as the substitute.
 *
 * The substitute is measured and then DISCARDED, which is the hole this closes:
 * `settleFromTranscript` runs `classifyTuiTurn` first and returns early unless
 * the reading is `ended` (`supervisor/index.ts:2262-2265`), so `TUI_QUIET_MS`
 * is consulted only AFTER an end marker has been seen. A container killed
 * mid-turn writes no end marker, the quiet clock is never started, and `phase`
 * stays `busy` for as long as the supervisor lives.
 *
 * ## The discriminator, and why this subtraction is legal
 *
 * `heartbeat_at` and `transcript_activity.last_growth_at` are written by the
 * SAME process from the SAME wall clock. Their difference is how long that
 * supervisor has watched the transcript stand still, measured entirely inside
 * one clock. This is NOT the cross-clock subtraction `util/clock.ts` bans and
 * `reaper.ts` goes to such lengths to avoid — there is no second clock in it —
 * which is why the answer survives a host suspend, a reader whose clock is
 * skewed, and a `--json` consumer on another machine. It also means this
 * function takes no `now`, and a caller cannot accidentally give it one.
 *
 * ## The honest edge
 *
 * A worker genuinely thinking for a long time between tool calls has a stalled
 * transcript too. The bands are therefore the fleet's, not this file's: under
 * `warnMs` the operator's own config calls the silence healthy, between the two
 * it calls for a warning and explicitly not a kill, and at `killMs` it kills a
 * slot-holding worker outright. **This alarms exactly where the fleet would
 * already kill**, so it cannot be stricter than the opinion the operator wrote
 * down, and a reviewer thinking for ten minutes reaches `quiet` and stops.
 *
 * `phase === "busy"` is the analogue of `classifyStall`'s `holdsSlot`, on that
 * field's own reasoning: silence alone is never grounds for an alarm, because a
 * worker not claiming to run anything is silent by design.
 *
 * A DEAD supervisor is excluded rather than judged. Both stamps froze together
 * when it died, so their difference is whatever it happened to be at that
 * moment; the line already reads `supervisor=gone`, which is the actionable
 * fact, and that is the reaper's business (`safety/reaper.ts`) rather than
 * this one's.
 */
export function classifyWorkerSilence(input: SilenceInput): SilenceReading {
  if (input.phase !== "busy") return { verdict: "not_applicable" };
  if (!input.supervisorAlive) return { verdict: "not_applicable" };
  if (input.activity === null) return { verdict: "unknown", why: "no_activity_record" };
  /*
   * MEASURED-AND-NEVER-GREW makes no claim about being stuck, and nothing
   * derived from it may make one — `supervisor/index.ts:2007-2010` says so in
   * the branch that writes it. A worker nobody has typed at yet carries exactly
   * this value, and alarming about it would turn a fresh pane into a fault.
   */
  if (input.activity.last_growth_at === null) return { verdict: "unknown", why: "no_growth_yet" };
  if (input.window === null) return { verdict: "unknown", why: "no_window" };

  const beat = input.heartbeatAt === null ? Number.NaN : Date.parse(input.heartbeatAt);
  const grew = Date.parse(input.activity.last_growth_at);
  if (Number.isNaN(beat) || Number.isNaN(grew)) {
    return { verdict: "unknown", why: "unreadable_stamp" };
  }

  // Clamped, on `ago`'s reasoning: the transcript poll can land microseconds
  // after the heartbeat that shares its tick, and a negative span would read as
  // a worker that wrote in the future rather than as sub-tick ordering.
  const silentMs = Math.max(0, beat - grew);
  if (silentMs >= input.window.killMs) return { verdict: "wedged", silentMs };
  if (silentMs >= input.window.warnMs) return { verdict: "quiet", silentMs };
  return { verdict: "working", silentMs };
}

/**
 * What to put on the status line, or nothing at all.
 *
 * SPEAKS FOR TWO OF THE FIVE VERDICTS, and the silences are as deliberate as
 * the words:
 *
 * - `wedged` is the alarm, and it is the only thing on this line printed in
 *   capitals. It names the span so the reader can tell a seat that went five
 *   minutes past the threshold from one that has been dead an hour, and it
 *   names the likely cause because "check the container" is the action.
 * - `working` and `quiet` say nothing. The line already carries `transcript
 *   41m ago` from `transcriptNote`, so a second rendering of the same fact
 *   would be noise — and printing `quiet` on every worker more than three
 *   minutes into a model call is noise on most of a healthy fleet.
 * - `unknown/no_window` DOES speak, because it is the one unknown with no other
 *   trace on the line. Without it an operator cannot tell "no alarm because
 *   healthy" from "no alarm because I have no threshold to judge against",
 *   which is exactly the collapse the verdict type exists to prevent.
 * - the other three unknowns stay quiet: `transcriptNote` has already printed
 *   `transcript no writes yet`, `transcript last write unreadable`, or nothing
 *   at all for a worker with no record.
 */
export function silenceNote(reading: SilenceReading): string | null {
  if (reading.verdict === "wedged") {
    return (
      `WEDGED heartbeating but transcript silent ${coarseDuration(reading.silentMs)} ` +
      `(container may be gone)`
    );
  }
  if (reading.verdict === "unknown" && reading.why === "no_window") {
    return "silence-window unknown";
  }
  return null;
}

/**
 * The run's silence window, or `null` when it cannot be had.
 *
 * DEGRADES where `dispatch` REFUSES, and the asymmetry is deliberate.
 * `readRunBudgetPolicy` throws `RunPolicyUnreadableError` on a `run.json` that
 * is present and unparseable, because answering an unknown token ceiling with
 * "unbounded" spends money that cannot be refunded. Nothing here spends
 * anything: this is a read-only snapshot, and it is the operator's ONLY view of
 * a fleet precisely when things have gone wrong. Refusing to print it because
 * one field of one file would not parse would remove the view at the moment it
 * is most needed.
 *
 * The degradation is not silent. With no window every busy worker reads
 * `unknown/no_window`, `silenceNote` prints `silence-window unknown` beside it,
 * and `--json` carries a null `window_ms`.
 */
async function readSilenceWindow(run: RunPaths): Promise<StallWindow | null> {
  try {
    return (await readRunBudgetPolicy(run)).stall;
  } catch {
    return null;
  }
}

/**
 * Register `pifleet status` (SRD §10): a fleet snapshot read entirely from
 * durable files — which is what makes re-attaching after a killed CLI work
 * (ISC-76): the supervisors never noticed the CLI die, and their state files
 * are the interface.
 */
export function register(program: Command): void {
  program
    .command("status")
    .description("Print a fleet snapshot")
    .option("--run <id>", "run id")
    .option("--all", "report on every run that still has a live worker")
    .option("--watch", "refresh until interrupted")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { run?: string; all?: boolean; watch?: boolean; json?: boolean }) => {
      const root = runsRoot();

      /*
       * `--all` reports every LIVE run, not every run ever.
       *
       * The operations console stands up one run per attached pane, because
       * `--attach-here` hands over the terminal of the process that runs it and
       * one process has one terminal. A status pane that showed only the newest
       * would report half the console and look, to the operator, like the other
       * half had died.
       *
       * Resolved fresh inside `emit` rather than once, so `--watch --all`
       * notices a run appearing or ending instead of holding the set it saw at
       * start.
       */
      const resolveRunIds = async (): Promise<string[]> => {
        if (opts.run !== undefined) return [opts.run];
        if (opts.all === true) {
          const live = await liveRunIds(root);
          if (live.length > 0) return live;
        }
        const one = (await latestLiveRunId(root)) ?? (await latestRunId(root));
        return one === null ? [] : [one];
      };

      const emitOne = async (runId: string): Promise<Record<string, unknown>> => {
        const run = runPaths(runId, root);
        const registry = await readRegistry(run);
        let workerIds: string[];
        try {
          workerIds = (await readdir(run.workersDir)).filter((w) => !w.startsWith("."));
        } catch {
          workerIds = [];
        }

        /*
         * ONCE per run, hoisted out of the worker loop.
         *
         * The window is a property of the RUN, so re-reading `run.json` for
         * every worker would buy nothing and would let a fleet of 500 workers
         * open 500 file descriptors for 500 copies of the same two numbers —
         * the concern `monitor/read/worker.ts` already states for its own
         * sequential reads.
         */
        const window = await readSilenceWindow(run);

        const workers: Array<{
          state: WorkerState | null;
          id: string;
          alive: boolean;
          silence: SilenceReading;
        }> = [];
        for (const id of workerIds.sort()) {
          const state = await readWorkerState(workerPaths(run, id));
          let alive = false;
          if (state !== null) {
            const registered = registry?.workers[id];
            // (pid, start-time) identity, never pid alone: a recycled pid must
            // not resurrect a dead supervisor in the snapshot.
            alive =
              registered !== undefined
                ? await identityAlive({ pid: registered.pid, started: registered.started })
                : (await processStartTime(state.pid)) !== null;
          }
          /*
           * Classified HERE and carried, not recomputed at each consumer. The
           * text line and `--json` must never be able to disagree about whether
           * a seat is wedged, and two call sites reading the same fields is how
           * they would come to.
           */
          const silence = classifyWorkerSilence({
            phase: state?.phase ?? null,
            supervisorAlive: alive,
            heartbeatAt: state?.heartbeat_at ?? null,
            activity: state?.transcript_activity ?? null,
            window,
          });
          workers.push({ id, state, alive, silence });
        }

        const snapshot = {
              run_id: runId,
              workers: workers.map((w) => ({
                id: w.id,
                alive: w.alive,
                phase: w.state?.phase ?? null,
                task_id: w.state?.task_id ?? null,
                // Carried into `--json` for the same reason
                // `transcript_activity` is, twelve lines down: the console
                // pane is one consumer, and a script asking "is anything
                // waiting on me" needs the same field the pane reads. Without
                // it a caller polling this JSON sees `phase: "idle"` and an
                // unfamiliar `task_id`, which is the console defect again in a
                // machine reader instead of a human one.
                staged_task_id: w.state?.staged_task_id ?? null,
                epoch: w.state?.epoch ?? null,
                completed_epochs: w.state?.completed_epochs ?? [],
                pid: w.state?.pid ?? null,
                pgid: w.state?.pgid ?? null,
                session_path: w.state?.session_path ?? null,
                session_present: w.state?.session_present ?? false,
                heartbeat_at: w.state?.heartbeat_at ?? null,
                // Carried into `--json` too, not only into the text line: the
                // console pane is one consumer, and a script asking "is the
                // fleet doing anything" needs the same field the pane reads.
                transcript_activity: w.state?.transcript_activity ?? null,
                /**
                 * The DERIVED verdict, beside the raw fields it was derived
                 * from rather than instead of them.
                 *
                 * Both are carried on purpose. A caller that disagrees with the
                 * bands — a dashboard with its own idea of "too long" — still
                 * has `heartbeat_at` and `transcript_activity` to do its own
                 * arithmetic on, and does not have to reverse-engineer this
                 * one. A caller that just wants to know whether to page someone
                 * reads `verdict` and stops.
                 *
                 * `why` and `silent_ms` are both present and both nullable
                 * rather than the field changing shape between verdicts: a JSON
                 * consumer that has to switch on a discriminator before it
                 * knows which keys exist is a consumer that will index the
                 * wrong one.
                 */
                silence: {
                  verdict: w.silence.verdict,
                  why: w.silence.verdict === "unknown" ? w.silence.why : null,
                  silent_ms:
                    w.silence.verdict === "working" ||
                    w.silence.verdict === "quiet" ||
                    w.silence.verdict === "wedged"
                      ? w.silence.silentMs
                      : null,
                  window_ms: window === null ? null : { warn: window.warnMs, kill: window.killMs },
                },
              })),
        };

        if (opts.json !== true) {
          process.stdout.write(`run ${runId}\n`);
          // ONE reading for every worker in the snapshot, so two panes whose
          // transcripts last grew in the same second cannot print different
          // ages because the loop took a moment to get to the second one.
          const nowMs = Date.now();
          for (const w of workers) {
            const phase = w.state?.phase ?? "unknown";
            const task = w.state?.task_id === null || w.state === null ? "-" : w.state.task_id;
            const live = w.alive ? "up" : "gone";
            const note = transcriptNote(w.state?.transcript_activity ?? null, nowMs);
            const suffix = note === null ? "" : ` ${note}`;
            /**
             * The staged task, named on the line rather than left to `phase`.
             *
             * A staged worker prints `idle`, and that is correct — nothing has
             * started, because starting it takes a keypress at a terminal
             * (SRD-TUI-DISPATCH §6.5). But `idle` alone is the console defect
             * `transcript_activity` was added for, read from the other end: a
             * pane that said `idle` about a worker that was busy sent an
             * operator looking for a fleet that had stopped. A pane that says
             * `idle` about a worker holding a staged task sends them looking
             * for a worker that is free, and it is not — the epoch is live and
             * the next dispatch will be refused `busy` by an allocator whose
             * refusal names an epoch the status line never mentioned.
             *
             * So the id is printed with the WORD `staged`, not as a second
             * bare `task=`. Two task ids on one line, distinguished only by
             * position, is a line the reader has to know the format of; this
             * one says which of the two facts each id is.
             *
             * Omitted entirely when there is nothing staged, like
             * `transcriptNote`'s `null`: every non-`tui` worker in the fleet
             * would otherwise carry a permanently empty column about a
             * mechanism it does not use.
             */
            const stagedId = w.state?.staged_task_id ?? null;
            const staged = stagedId === null ? "" : ` staged=${stagedId}`;
            /**
             * LAST on the line, and loud.
             *
             * Last because everything before it is a FACT read off disk and
             * this is a JUDGEMENT made about them; a reader who distrusts the
             * judgement can still see every input to it on the same line.
             *
             * Loud because the whole defect was a line that looked fine. `busy
             * task=t-3 supervisor=up transcript 41m ago` is four true fields
             * describing a seat with nothing in it, and an operator scanning a
             * pane of ten workers reads the shape before the numbers.
             *
             * Empty when there is nothing to say, on `transcriptNote`'s rule:
             * a healthy fleet's status output must be byte-identical to what it
             * was before this column existed, or the column has cost every
             * reader something to gain the few who needed it.
             */
            const wedge = silenceNote(w.silence);
            const alarm = wedge === null ? "" : ` ${wedge}`;
            process.stdout.write(
              `  ${w.id}: ${phase} task=${task}${staged} supervisor=${live}${suffix}${alarm}\n`,
            );
          }
        }
        return snapshot;
      };

      const emit = async (): Promise<void> => {
        const runIds = await resolveRunIds();
        if (runIds.length === 0) throw new CliError("no runs found", EXIT.USAGE);
        const snapshots: Array<Record<string, unknown>> = [];
        for (const id of runIds) snapshots.push(await emitOne(id));
        if (opts.json === true) {
          // `--all` wraps, a single run does NOT. The unwrapped shape is what
          // every existing caller parses, and quietly changing it for them to
          // gain a flag they did not pass is how a JSON contract breaks.
          const payload = opts.all === true ? { runs: snapshots } : snapshots[0]!;
          process.stdout.write(`${JSON.stringify(payload)}\n`);
        }
      };

      if (opts.watch === true) {
        // Refresh until interrupted; SIGINT is the exit path.
        for (;;) {
          await emit();
          await new Promise((r) => setTimeout(r, 1_000));
        }
      }
      await emit();
    });
}
