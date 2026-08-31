/**
 * `pifleet shell --worker <id>`: an interactive shell inside that worker's
 * container, on ANY backend.
 *
 * ## Why this verb exists when `tui` looks like it already does
 *
 * `tui` hands a worker's PANE to a person, and a pane is a presentation-plane
 * object: it reads `presentation.json`, swaps what the pane runs, and writes an
 * attended record that voids requirements in `report`. On `headless` there is
 * no pane, so `tui` refuses — correctly, because writing an attended record for
 * a pane that cannot exist would mark a run attended that nobody attended.
 *
 * But the refusal is about the PANE, not about the container. A headless
 * worker has exactly the same container, the same mounts, the same egress
 * policy and the same absent credentials as a pane-backed one, and an operator
 * on the default backend had no way in. This command is that way in: the same
 * `interactiveArgv` the attended path uses, with no pane to swap and no
 * attended record to write.
 *
 * ## What this is NOT, and the distinction is load-bearing
 *
 * It is NOT a shell "to Pi". `interactiveArgv`'s own docblock states the
 * reason: this fleet launches Pi in RPC MODE with the supervisor holding stdin,
 * so attaching a human keyboard to that JSONL protocol stream would corrupt the
 * control plane on the first keystroke. `docker exec` gives a person hands
 * inside the same boundary WITHOUT touching Pi's pipes, which is exactly what
 * keeps dispatch, steer, abort and harvest working while someone is typing.
 *
 * To talk TO the agent mid-turn, the verb is `steer`. To watch it work, it is
 * `logs --follow --render`. This is for the third thing — looking around the
 * container the agent is looking around.
 *
 * ## No attended record, deliberately
 *
 * `tui` writes one because it changes what a PANE shows, and a reader of
 * `report` must know the pane they are reasoning about was driven by a person.
 * This changes nothing any reporting surface reads: it opens a second process
 * beside the agent and exits. Writing an attended record here would void
 * requirements for a run that was never attended in the sense `report` means —
 * a strictly worse lie than the one the record exists to prevent.
 */

import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { interactiveArgv } from "../../attended/mode.ts";
import { requireLiveWorker, resolveRunPaths } from "../worker-preflight.ts";

export function register(program: Command): void {
  program
    .command("shell")
    .description("Open an interactive shell inside a worker's container")
    .option("-w, --worker <id>", "worker id")
    .option("-r, --run <id>", "run id (defaults to the most recent LIVE run)")
    .action(async (opts: { worker?: string; run?: string }) => {
      if (opts.worker === undefined || opts.worker.trim() === "") {
        throw new CliError("shell requires --worker <id>", EXIT.USAGE);
      }
      const run = await resolveRunPaths(opts.run);
      // LIVENESS FIRST, and it is not a formality: `docker exec` against a
      // container whose supervisor is gone either fails with a docker error
      // that names no worker, or — worse — succeeds against a container the
      // reaper has not got to yet, handing someone a shell in a dead run they
      // believe is live. `requireLiveWorker` refuses with the run, the worker
      // and which of the two ways it is dead.
      const state = await requireLiveWorker(run, opts.worker);
      if (state.container === null) {
        // The `PIFLEET_PI_COMMAND` path — the acceptance suite and the fake-Pi
        // phases run with no container at all. Saying so beats `docker exec`
        // failing on a name that was never created, which reads like a docker
        // problem rather than like a run that has no container by design.
        throw new CliError(
          `worker ${opts.worker} in run ${run.runId} has no container (it was launched with ` +
            `PIFLEET_PI_COMMAND, so there is nothing to exec into)`,
          EXIT.USAGE,
        );
      }

      const argv = interactiveArgv(run.runId, opts.worker);
      // INHERITED stdio, and this is the whole command. A captured or piped
      // stream is not a terminal, `docker exec -it` fails on it, and the
      // operator gets "the input device is not a TTY" instead of a shell.
      const proc = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
      // The inner shell's exit code is passed through rather than mapped onto
      // the §10 ladder: a person typing `exit 3` means 3, and this process is a
      // transport for their session, not a fleet operation with a verdict.
      process.exit(await proc.exited);
    });
}
