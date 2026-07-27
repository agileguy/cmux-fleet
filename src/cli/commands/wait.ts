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
import { readTaskRecord, readWorkerState, type TaskRecord } from "../../run/state.ts";
import { processStartTime } from "../../run/registry.ts";
import { Stopwatch } from "../../rpc/client.ts";

const POLL_MS = 100;

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
      const exit = worstExit(codes);

      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify({ run_id: runId, exit, tasks })}\n`);
      } else {
        for (const t of tasks) {
          process.stdout.write(`${t.task_id}: ${t.verdict}${t.reason ? ` (${t.reason})` : ""}\n`);
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
