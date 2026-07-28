/**
 * `pifleet abort --worker <id>` (SRD §10, ISC-81): cancel the current epoch.
 *
 * `abort` is a REQUEST, and the output says so. The supervisor acks the
 * moment it has recorded the intent (`noteAbortRequested` + durable fence)
 * and fires the RPC at Pi without awaiting it — a wedged agent may never
 * honour an abort, and a CLI that blocked on the agent's cooperation would
 * hang on exactly the workers most worth aborting. So the JSON field is
 * `requested`, not `aborted`: the worker returning to `idle` (within 10s,
 * ISC-81) is observable in `state.json` and `status`, and claiming it here
 * would be reporting a future as a fact.
 *
 * A worker with nothing in flight refuses (`no live epoch`), and the refusal
 * is surfaced: an abort of nothing reported as success teaches the operator
 * that abort is a no-op they can spam, right up until the day one lands on a
 * task they wanted kept.
 */

import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { controlCall } from "../../supervisor/launch.ts";
import { requireLiveWorker, resolveRunPaths } from "../worker-preflight.ts";

/**
 * The supervisor answers an abort from memory (no inner RPC awaited), so the
 * socket default would do — but a supervisor mid-GC or mid-settle under load
 * deserves the same patience the other verbs get.
 */
const ABORT_TIMEOUT_MS = 10_000;

export function register(program: Command): void {
  program
    .command("abort")
    .description("Cancel a worker's current epoch")
    .option("-w, --worker <id>", "worker id")
    .option("-r, --run <id>", "run id (defaults to the most recent run)")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { worker?: string; run?: string; json?: boolean }) => {
      if (opts.worker === undefined || opts.worker.trim() === "") {
        throw new CliError("abort requires --worker <id>", EXIT.USAGE);
      }
      const run = await resolveRunPaths(opts.run);
      // Liveness BEFORE the socket: a typo'd worker and a dead one refuse
      // connect identically, and only the state file can tell 2 from 6.
      const state = await requireLiveWorker(run, opts.worker);

      let reply: Record<string, unknown>;
      try {
        reply = await controlCall(
          run,
          opts.worker,
          { cmd: "abort" },
          { timeoutMs: ABORT_TIMEOUT_MS },
        );
      } catch (err) {
        throw new CliError(
          `worker ${opts.worker} in run ${run.runId} is unreachable: ${String(err)}`,
          EXIT.WORKER_DIED,
        );
      }

      if (reply["ok"] !== true) {
        const error = typeof reply["error"] === "string" ? reply["error"] : "rejected";
        if (error === "no live epoch") {
          throw new CliError(
            `worker ${opts.worker} in run ${run.runId} has no live epoch — nothing to abort`,
            EXIT.USAGE,
          );
        }
        throw new CliError(
          `worker ${opts.worker} did not accept the abort: ${error}`,
          EXIT.PARTIAL,
        );
      }

      // The supervisor's own ledger row (`abort_requested`) records the
      // intent; this one records WHO asked, which the supervisor cannot know.
      const ledger = new LedgerWriter(run, `cli-abort-${process.pid}`);
      await ledger.append("abort_sent", {
        worker: opts.worker,
        task_id: state.task_id ?? undefined,
      });

      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify({
            run_id: run.runId,
            worker: opts.worker,
            requested: true,
            // What was in flight when we asked — the task the operator is
            // aborting, named so a mis-aimed abort is visible immediately.
            task_id: state.task_id,
            epoch: state.epoch,
          })}\n`,
        );
      } else {
        process.stdout.write(
          `abort requested for ${opts.worker}${state.task_id !== null ? ` (task ${state.task_id})` : ""}\n`,
        );
      }
    });
}
