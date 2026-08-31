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
 *
 * ## The `tui` worker has no control socket (SRD §3.5, TUI spec item 8)
 *
 * A `pane_mode: tui` worker is launched without `--mode rpc` and the
 * supervisor holds none of its three streams, so there is no `abort` RPC to
 * send. §3.5 says such a worker is interrupted with `docker kill
 * --signal=INT`, and `src/container/interrupt.ts` carries the measurements
 * showing what that verb actually does — it is a graceful STOP of the worker
 * by way of the entrypoint's signal trap, not the turn-cancel the same word
 * means on the rpc path.
 *
 * That difference is reported rather than smoothed over. Both routes still
 * answer `requested`, because both are true to the same standard — the rpc
 * path has asked an agent that may never honour it, and `docker kill` has
 * delivered a signal whose effect lands afterwards — but the JSON names
 * `via`, so a reader can tell which operation happened. Presenting a stop as
 * an epoch cancel would let an operator believe a tui worker is still alive
 * and waiting for the next dispatch.
 *
 * The route is decided from the launch record, never from config: `up`
 * resolved the mode in a cwd and environment this process does not share, and
 * `launch.json` is what the supervisor actually ran. See `launchPaneMode`.
 */

import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { controlCall } from "../../supervisor/launch.ts";
import { requireLiveWorker, resolveRunPaths } from "../worker-preflight.ts";
import { INTERRUPT_SIGNAL, planInterrupt } from "../../container/interrupt.ts";
import { realExec } from "../../container/run.ts";
import { readWorkerLaunch } from "../../run/state.ts";
import { workerPaths } from "../../run/paths.ts";

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

      // Which control plane this worker has, read off what `up` actually ran.
      const plan = planInterrupt(await readWorkerLaunch(workerPaths(run, opts.worker)));

      if (plan.kind === "unavailable") {
        throw new CliError(
          `worker ${opts.worker} in run ${run.runId} cannot be aborted: ${plan.reason}`,
          EXIT.USAGE,
        );
      }

      /** Extra JSON fields naming WHICH operation happened. */
      let route: Record<string, unknown>;

      if (plan.kind === "signal") {
        const result = await realExec(plan.argv, { timeoutMs: ABORT_TIMEOUT_MS });
        if (result.timedOut) {
          throw new CliError(
            `docker kill --signal=${INTERRUPT_SIGNAL} ${plan.container} did not return ` +
              `within ${ABORT_TIMEOUT_MS}ms`,
            EXIT.WORKER_DIED,
          );
        }
        if (result.code !== 0) {
          /**
           * A container that is already gone is the common case here and is
           * still a failure to REPORT, not one to swallow: the operator asked
           * to stop something and needs to know it was not this command that
           * stopped it. `docker kill` writes its own diagnosis to stderr
           * ("No such container", "is not running"), which is more specific
           * than anything this layer could reconstruct.
           */
          throw new CliError(
            `docker kill --signal=${INTERRUPT_SIGNAL} ${plan.container} failed ` +
              `(exit ${String(result.code)}): ${result.stderr.trim()}`,
            EXIT.WORKER_DIED,
          );
        }
        route = { via: "docker_kill", signal: INTERRUPT_SIGNAL, container: plan.container };
      } else {
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
        route = { via: "rpc" };
      }

      // The supervisor's own ledger row (`abort_requested`) records the
      // intent; this one records WHO asked, which the supervisor cannot know.
      // The event name is unchanged across both routes so existing readers of
      // `abort_sent` still see every abort; `detail` is where they differ.
      const ledger = new LedgerWriter(run, `cli-abort-${process.pid}`);
      await ledger.append("abort_sent", {
        worker: opts.worker,
        task_id: state.task_id ?? undefined,
        detail: route,
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
            ...route,
          })}\n`,
        );
      } else {
        const how =
          plan.kind === "signal"
            ? ` (SIGINT to ${plan.container} — a tui worker has no control socket; this stops it)`
            : "";
        process.stdout.write(
          `abort requested for ${opts.worker}${state.task_id !== null ? ` (task ${state.task_id})` : ""}${how}\n`,
        );
      }
    });
}
