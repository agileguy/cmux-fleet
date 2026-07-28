/**
 * `pifleet exec --worker <id> -- <cmd>` (SRD §10): run a command in that
 * worker's container, for debugging.
 *
 * Two environments, one honest distinction. A worker launched with a
 * container gets `docker exec` against the recorded container name. A worker
 * with none — the fake-Pi phases, the acceptance suite — runs the command on
 * the HOST, and that is said out loud in both output modes: an operator who
 * believes they are inside the container's mount table and egress policy
 * while actually on the host is one `rm` away from a very bad afternoon.
 * Refusing outright instead would leave the verb untestable on the headless
 * path the SRD makes normative for the acceptance suite (§11).
 *
 * Exit codes stay on the §10 ladder. The inner command's exit code is a
 * DATUM (in `--json` and the human summary), not this process's exit code:
 * an inner `exit 2` surfacing as the ladder's "usage error" would lie to
 * every orchestrator switching on the integer. Nonzero inner exit maps to
 * EXIT.PARTIAL — ran, did not succeed — and a timeout to EXIT.TIMEOUT.
 */

import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { realExec } from "../../container/run.ts";
import { requireLiveWorker, resolveRunPaths } from "../worker-preflight.ts";

/**
 * A debugging command gets ten minutes, then the ladder's honest answer.
 * `realExec` SIGTERMs then SIGKILLs at the bound, so a wedged inner command
 * cannot wedge the CLI — the exact failure `exec` exists to investigate.
 */
const EXEC_TIMEOUT_MS = 600_000;

/**
 * Where the command runs and the argv that runs it. Pure, exported for the
 * unit suite: the container/host branch is the safety-relevant decision in
 * this file, and it must be pinnable without docker installed.
 */
export function execArgv(
  container: { name: string } | null,
  cmd: readonly string[],
): { argv: string[]; ran_in: "container" | "host" } {
  if (container !== null) {
    return { argv: ["docker", "exec", container.name, ...cmd], ran_in: "container" };
  }
  return { argv: [...cmd], ran_in: "host" };
}

export function register(program: Command): void {
  program
    .command("exec [cmd...]")
    .description("Run a command inside a worker's container")
    .option("-w, --worker <id>", "worker id")
    .option("-r, --run <id>", "run id (defaults to the most recent run)")
    .option("--json", "emit machine-readable output")
    .action(
      async (
        cmd: string[],
        opts: { worker?: string; run?: string; json?: boolean },
      ) => {
        if (opts.worker === undefined || opts.worker.trim() === "") {
          throw new CliError("exec requires --worker <id>", EXIT.USAGE);
        }
        if (cmd.length === 0) {
          throw new CliError("exec requires a command after -- (e.g. exec -w eng-1 -- ls)", EXIT.USAGE);
        }
        const run = await resolveRunPaths(opts.run);
        // Liveness BEFORE anything runs: a typo'd worker and a dead one must
        // sort into 2 and 6 here, and a dead worker's container is exactly
        // the thing `docker exec` would produce a confusing error against.
        const state = await requireLiveWorker(run, opts.worker);

        const { argv, ran_in } = execArgv(state.container, cmd);
        if (ran_in === "host" && opts.json !== true) {
          // Loud, and on stderr so it never contaminates piped output.
          process.stderr.write(
            `exec: worker ${opts.worker} has no container — running on the HOST\n`,
          );
        }

        // `realExec` never throws: a missing binary is 127-with-stderr, a
        // timeout is a flagged result. Every outcome below is a report.
        const result = await realExec(argv, { timeoutMs: EXEC_TIMEOUT_MS });

        // Audit row: which command, where it ran, how it ended. `exec` is an
        // operator's hand inside a worker, and a run record that cannot show
        // that happened would make every derived fact quietly unreviewable.
        const ledger = new LedgerWriter(run, `cli-exec-${process.pid}`);
        await ledger.append("exec_run", {
          worker: opts.worker,
          detail: {
            command: cmd.join(" ").slice(0, 500),
            ran_in,
            exit_code: result.code,
            timed_out: result.timedOut,
          },
        });

        if (opts.json === true) {
          process.stdout.write(
            `${JSON.stringify({
              run_id: run.runId,
              worker: opts.worker,
              ran_in,
              container: state.container?.name ?? null,
              command: cmd,
              exit_code: result.code,
              timed_out: result.timedOut,
              stdout: result.stdout,
              stderr: result.stderr,
            })}\n`,
          );
        } else {
          process.stdout.write(result.stdout);
          process.stderr.write(result.stderr);
        }

        if (result.timedOut) {
          throw new CliError(
            `command timed out after ${EXEC_TIMEOUT_MS}ms in worker ${opts.worker}`,
            EXIT.TIMEOUT,
          );
        }
        if (result.code !== 0) {
          throw new CliError(
            `command exited ${result.code} in worker ${opts.worker}`,
            EXIT.PARTIAL,
          );
        }
      },
    );
}
