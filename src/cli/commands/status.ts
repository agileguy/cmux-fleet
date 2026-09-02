import type { Command } from "commander";
import { readdir } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT, type WorkerState } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readWorkerState } from "../../run/state.ts";
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
  const s = Math.max(0, Math.round((nowMs - then) / 1_000));
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

        const workers: Array<{ state: WorkerState | null; id: string; alive: boolean }> = [];
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
          workers.push({ id, state, alive });
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
            process.stdout.write(
              `  ${w.id}: ${phase} task=${task}${staged} supervisor=${live}${suffix}\n`,
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
