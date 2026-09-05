import type { Command } from "commander";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT, worstExit, type ExitCode } from "../../contracts.ts";
import {
  inboxTaskPath,
  latestRunId,
  runPaths,
  runsRoot,
  taskRecordPath,
  workerPaths,
} from "../../run/paths.ts";
import {
  readBudgetState,
  readTaskRecord,
  readWorkerLaunch,
  readWorkerState,
  type TaskRecord,
} from "../../run/state.ts";
import { budgetExitCode } from "../../safety/budget.ts";
import { processStartTime } from "../../run/registry.ts";
import { Stopwatch } from "../../rpc/client.ts";

const POLL_MS = 100;

/**
 * How long a stage on an AUTO-TRIGGERED worker may sit unpicked-up before
 * `wait` stops believing the trigger is coming (see the staged branch below).
 *
 * It is a backstop and not a schedule. The observed gap between a staged
 * dispatch and the transcript growth that clears `staged_task_id` is seconds —
 * the supervisor polls the pane every `TUI_POLL_MS` and the agent's first
 * message follows — so a healthy trigger never approaches this. What it bounds
 * is the case the flag cannot see: the extension mounted and did nothing.
 *
 * Two orders of magnitude below the 10m default timeout, which is the property
 * that matters. §6.5's objection to waiting was never "waiting is wrong", it
 * was that a `wait` which consumes its whole deadline reports `wait_timeout` —
 * a clock, not a cause. Settling here reports the cause.
 */
const STAGE_TRIGGER_GRACE_MS = 120_000;

/**
 * The grace, with the same env seam the runs directory and the Pi command
 * already use — `PIFLEET_STAGE_TRIGGER_GRACE_MS`.
 *
 * Two minutes is the right backstop in a real run and the wrong one in a unit
 * test, which would have to sleep through it to observe the stall arm at all.
 * Without a seam that arm is untestable at unit speed and would have to be
 * pinned structurally, which is how a branch that never executes gets to keep
 * looking correct.
 *
 * Read per call rather than captured at import: the suite sets it around an
 * invocation, exactly as it does `PIFLEET_RUNS_DIR`.
 */
function stageTriggerGraceMs(): number {
  const raw = process.env["PIFLEET_STAGE_TRIGGER_GRACE_MS"];
  if (raw === undefined) return STAGE_TRIGGER_GRACE_MS;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) && n >= 0 ? n : STAGE_TRIGGER_GRACE_MS;
}

interface WaitedTask {
  task_id: string;
  worker: string;
  epoch: number | null;
  verdict: string;
  reason: string;
}

/**
 * Register `pifleet wait` (SRD §10): block until tasks settle or a deadline
 * elapses. Entirely file-driven — task records written by supervisors — so it
 * works from a CLI that never dispatched anything (ISC-76).
 *
 * Exit is the §10 severity ladder via `worstExit`: one `wait --all` can
 * legitimately have a timeout AND a dead worker AND a failed task, and the
 * highest severity must win. `--json` always carries per-task terminal state
 * so no caller has to infer from the integer alone.
 */
export function register(program: Command): void {
  program
    .command("wait")
    .description("Block until tasks settle or a deadline elapses")
    .option("--run <id>", "run id")
    .option("--task <id>", "single task id")
    .option("--all", "wait for every dispatched task")
    .option("--timeout <duration>", "overall timeout, e.g. 25m", "10m")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { run?: string; task?: string; all?: boolean; timeout: string; json?: boolean }) => {
      const root = runsRoot();
      const runId = opts.run ?? (await latestRunId(root));
      if (runId === null) throw new CliError("no runs found", EXIT.USAGE);
      const run = runPaths(runId, root);
      // A run id that names nothing is a usage error, not an empty wait. The
      // inbox scan below cannot tell "no tasks dispatched yet" from "this run
      // does not exist", and reporting exit 0 for a typo'd --run tells an
      // orchestrator its work succeeded.
      //
      // The predicate is the run DIRECTORY, not run.json: a supervisor can be
      // launched against a run dir that `up` did not build, and requiring the
      // manifest would reject those while catching no additional typos.
      if (!existsSync(run.root)) {
        throw new CliError(`no such run: ${runId} (looked in ${root})`, EXIT.USAGE);
      }
      const timeoutMs = parseDuration(opts.timeout);

      const targets = async (): Promise<string[]> => {
        if (opts.task !== undefined) return [opts.task];
        try {
          return (await readdir(run.inboxDir))
            .filter((f) => f.endsWith(".json"))
            .map((f) => f.slice(0, -".json".length));
        } catch {
          return [];
        }
      };

      const workerFor = async (taskId: string): Promise<string | null> => {
        try {
          const envelope = JSON.parse(await Bun.file(inboxTaskPath(run, taskId)).text()) as {
            worker?: string;
          };
          return envelope.worker ?? null;
        } catch {
          return null;
        }
      };

      const findRecord = async (taskId: string): Promise<TaskRecord | null> => {
        const worker = await workerFor(taskId);
        const workerIds =
          worker !== null
            ? [worker]
            : await readdir(run.workersDir).then(
                (ws) => ws.filter((w) => !w.startsWith(".")),
                () => [],
              );
        for (const id of workerIds) {
          const record = await readTaskRecord(taskRecordPath(workerPaths(run, id), taskId));
          if (record !== null) return record;
        }
        return null;
      };

      const clock = new Stopwatch();
      const results = new Map<string, WaitedTask>();
      let timedOutWaiting = false;
      /**
       * Launch records are immutable for the life of a run, so this is read
       * once per worker rather than once per 100ms poll. `null` is cached as
       * eagerly as a record: the double-driven suites have no launch.json at
       * all and would otherwise re-stat a missing file on every tick.
       */
      const launches = new Map<string, boolean>();
      const autoTriggered = async (worker: string): Promise<boolean> => {
        const cached = launches.get(worker);
        if (cached !== undefined) return cached;
        const launch = await readWorkerLaunch(workerPaths(run, worker));
        const armed = launch?.auto_trigger ?? false;
        launches.set(worker, armed);
        return armed;
      };
      /** First tick at which each task was OBSERVED staged — see below. */
      const stagedSince = new Map<string, number>();

      for (;;) {
        const taskIds = await targets();
        if (taskIds.length === 0 && opts.task === undefined) {
          // Nothing was ever dispatched; nothing to wait for.
          break;
        }
        let pending = 0;
        for (const taskId of taskIds) {
          if (results.has(taskId)) continue;
          const record = await findRecord(taskId);
          if (record !== null) {
            results.set(taskId, {
              task_id: taskId,
              worker: record.worker,
              epoch: record.epoch,
              verdict: record.verdict,
              reason: record.reason,
            });
            continue;
          }
          // No record yet: is the owning supervisor even alive to produce one?
          const worker = await workerFor(taskId);
          if (worker !== null) {
            const state = await readWorkerState(workerPaths(run, worker));
            const dead =
              state !== null &&
              (state.phase === "dead" || (await processStartTime(state.pid)) === null);
            if (dead) {
              // SIGKILL leaves no task record; absence of the supervisor is
              // the evidence. `unknown` — never an invented failure detail.
              results.set(taskId, {
                task_id: taskId,
                worker,
                epoch: null,
                verdict: "unknown",
                reason: "worker_died",
              });
              continue;
            }
            /**
             * STAGED AND NEVER TRIGGERED — settled here rather than waited on
             * (ISC-445, SRD-TUI-DISPATCH §6.5).
             *
             * Reading the same `state` the death check already read, because
             * the two questions are asked about the same file at the same
             * moment and a second read could see a different one.
             *
             * ## Why this is a terminal answer and not another `pending++`
             *
             * A task with no record is normally a task still running, and
             * waiting is exactly right for it. A STAGED task has no record for
             * a different reason: nothing has started, and nothing will until
             * a person presses a key at a terminal this process cannot see or
             * reach. So the poll below has no event to wait for. It would spin
             * for the full `--timeout` and then report `wait_timeout` — a
             * diagnosis that says a clock ran out, sending the reader to
             * investigate a slow task when the remedy is a keystroke.
             *
             * **The timeout is the cost, and it is why this is a criterion.**
             * §6.5 puts it plainly: a `wait` that blocks on a key nobody
             * pressed is the hang this whole design exists to avoid. The
             * default is 10 minutes and orchestrators pass much more, so the
             * difference between answering here and answering at the deadline
             * is the difference between a console that reports a staged task
             * and one that appears wedged. ISC-445's probe therefore asserts
             * the CLOCK as well as the code.
             *
             * `verdict: "unknown"` and not a verdict of its own: `unknown` is
             * the lattice's identity element — "no evidence either way" — and
             * that is precisely the state of a task that has not run. The
             * reason string carries the distinction, and `exitFor` maps it to
             * `EXIT.STAGED` so a caller reading only `$?` gets it too.
             *
             * The check is `=== taskId` rather than `!== null`: one worker's
             * staged task must not settle a DIFFERENT task that happens to be
             * waiting on the same worker. That case is real — a second stage is
             * refused `busy`, so the second task's dispatch failed and it has
             * no record for an unrelated reason — and reporting it as staged
             * would name the wrong remedy.
             */
            if (state !== null && state.staged_task_id === taskId) {
              /**
               * ...UNLESS SOMETHING IS ALREADY ON ITS WAY TO TRIGGER IT.
               *
               * The paragraphs above rest on one premise — "nothing will start
               * until a person presses a key" — and that premise is false for
               * the majority of this fleet. `auto_trigger` defaults TRUE
               * (`config/load.ts`), so every `tui` worker is launched with the
               * dispatch-trigger extension mounted and picks its own stage up
               * seconds later, with nobody at the terminal.
               *
               * For those workers `staged_task_id === taskId` is not a resting
               * state at all. It is the GAP between the stage landing and the
               * transcript growth that clears it — and a `wait` issued in the
               * same breath as its dispatch lands inside that gap every time.
               * The observed shape: dispatch returns `via: staged`, `wait`
               * returns `staged_untriggered` and exit 9 within seconds, and a
               * concurrent `status` on the same run reports `phase: busy` with
               * the transcript already growing. The task then succeeds. The
               * verdict was wrong at the instant it was written, and it names a
               * remedy — go press a key — for a worker nobody needs to visit.
               *
               * So the branch asks the launch record which kind of stage this
               * is. Unattended: answer now, exactly as before. Auto-triggered:
               * keep polling, and treat a stage that OUTLIVES
               * the trigger grace as its own diagnosis rather than as
               * either of the two lies available — `staged_untriggered` would
               * send the reader to a keyboard, and falling through to the poll
               * would report a clock.
               *
               * `readWorkerLaunch` returning `null` — the double-driven suites,
               * and any run predating the field — resolves FALSE and therefore
               * to the original behaviour, which is why ISC-445's sub-second
               * probe is untouched by this.
               */
              if (await autoTriggered(worker)) {
                const since = stagedSince.get(taskId) ?? clock.elapsedMs();
                stagedSince.set(taskId, since);
                if (clock.elapsedMs() - since <= stageTriggerGraceMs()) {
                  pending++;
                  continue;
                }
                results.set(taskId, {
                  task_id: taskId,
                  worker,
                  epoch: state.epoch,
                  verdict: "unknown",
                  reason: "staged_trigger_stalled",
                });
                continue;
              }
              results.set(taskId, {
                task_id: taskId,
                worker,
                epoch: state.epoch,
                verdict: "unknown",
                reason: "staged_untriggered",
              });
              continue;
            }
          }
          pending++;
        }
        if (pending === 0) break;
        if (clock.elapsedMs() > timeoutMs) {
          timedOutWaiting = true;
          for (const taskId of taskIds) {
            if (!results.has(taskId)) {
              results.set(taskId, {
                task_id: taskId,
                worker: (await workerFor(taskId)) ?? "unknown",
                epoch: null,
                verdict: "unknown",
                reason: "wait_timeout",
              });
            }
          }
          break;
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }

      const tasks = [...results.values()];
      const codes: ExitCode[] = tasks.map((t) => exitFor(t));
      if (timedOutWaiting) codes.push(EXIT.TIMEOUT);
      /**
       * The run's budget verdict joins the ladder here (ISC-193, ISC-235).
       *
       * `wait` is file-driven and knows nothing about who dispatched, so
       * without this a `dispatch --auto` that halted on its ceiling would
       * report 5 while a `dispatch` + `wait` pipeline over the SAME run
       * reported 0 — the two spellings of a run disagreeing about what it
       * cost, which is exactly the divergence `exitFor`'s header says the
       * shared mapping exists to prevent.
       *
       * Null is the normal state of a run nobody scheduled, and contributes
       * nothing: a manual dispatch has no budget.json and no ceiling to
       * cross.
       */
      const budget = await readBudgetState(run);
      if (budget !== null) codes.push(budgetExitCode(budget));
      const exit = worstExit(codes);

      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify({
            run_id: runId,
            exit,
            tasks,
            // Additive: a consumer that switched on the integer alone could
            // not tell 5-because-budget from any other 5 without re-reading
            // the run directory itself.
            budget:
              budget === null
                ? null
                : {
                    halted_at: budget.halted_at,
                    halted_reason: budget.halted_reason,
                    tokens_spent: budget.tokens_spent,
                    tokens_ceiling: budget.tokens_ceiling,
                  },
          })}\n`,
        );
      } else {
        for (const t of tasks) {
          process.stdout.write(`${t.task_id}: ${t.verdict}${t.reason ? ` (${t.reason})` : ""}\n`);
        }
        if (budget !== null && budget.halted_at !== null) {
          process.stdout.write(`budget: halted (${budget.halted_reason ?? "ceiling crossed"})\n`);
        }
      }
      if (exit !== EXIT.SUCCESS) {
        throw new CliError(`wait finished with non-success terminal states`, exit);
      }
    });
}

function exitFor(t: WaitedTask): ExitCode {
  // Order matters: a wait that timed out on a LIVE worker is a timeout, not a
  // dead worker — and WORKER_DIED outranks TIMEOUT in the ladder, so mapping
  // the unknown verdict first would misreport every slow task as a death.
  if (t.reason === "wait_timeout") return EXIT.TIMEOUT;
  if (t.reason === "worker_died") return EXIT.WORKER_DIED;
  /**
   * The constraint the two lines above establish, stated once for all three:
   * every reason check must precede the `verdict` switch, because all three of
   * these tasks carry `verdict: "unknown"` and the switch maps that to
   * `EXIT.PARTIAL`. A staged task reported as 7 is ISC-216's shape — "some
   * tasks did not succeed", answered by investigating a failure that never
   * happened — and `EXIT.STAGED` exists precisely to be distinguishable from
   * that 7.
   *
   * Placed LAST among the reason checks rather than first, mirroring
   * `EXIT_SEVERITY`, where `STAGED` sits below both `TIMEOUT` and
   * `WORKER_DIED`. The order is presentational here and not load-bearing —
   * `reason` holds one value, so no task can match two of these arms — and it
   * is written this way so the function reads in the ladder's order rather
   * than requiring a reader to check that the arms are disjoint.
   */
  if (t.reason === "staged_untriggered") return EXIT.STAGED;
  /**
   * A stage whose trigger was armed and never fired is the SAME CLASS as one
   * nobody pressed a key for — the epoch was allocated and no turn began — so
   * it maps to the same code. Only the `reason` differs, and it has to: the
   * remedy for this one is to look at why the extension did not fire, not to
   * walk over to a terminal.
   */
  if (t.reason === "staged_trigger_stalled") return EXIT.STAGED;
  switch (t.verdict) {
    case "success":
      return EXIT.SUCCESS;
    case "timed_out":
      return EXIT.TIMEOUT;
    case "unknown":
      // `unknown` is the lattice's IDENTITY element, not its bottom
      // (contracts.ts): it means "no evidence either way", which is what a
      // live-but-unadjudicated outcome looks like. WORKER_DIED is a specific
      // diagnosis and it outranks TIMEOUT and PARTIAL, so mapping `unknown` to
      // it lets one unadjudicated task report the whole fleet as dead. A real
      // death arrives as `reason === "worker_died"`, handled above.
      return EXIT.PARTIAL;
    default:
      // failed | blocked | partial | aborted — "some tasks not success".
      return EXIT.PARTIAL;
  }
}

/** `500ms`, `30s`, `25m`, `2h`, or a bare number of seconds. */
export function parseDuration(text: string): number {
  const m = /^(\d+)(ms|s|m|h)?$/.exec(text.trim());
  if (m === null) throw new CliError(`invalid duration: ${text}`, EXIT.USAGE);
  const n = Number.parseInt(m[1]!, 10);
  switch (m[2] ?? "s") {
    case "ms":
      return n;
    case "s":
      return n * 1_000;
    case "m":
      return n * 60_000;
    case "h":
      return n * 3_600_000;
    default:
      return n * 1_000;
  }
}
