/**
 * `pifleet attach --worker <id>` (SRD §10, ISC-130): focus that worker's pane.
 *
 * Focus is the ONLY thing this does. It does not attach a terminal, does not
 * read the pane, and does not touch the control plane — the pane is a view
 * (SRD §3.3), so pointing the operator at one cannot change what a run does.
 *
 * The backend is read from the worker's `presentation.json` rather than taken
 * from a flag, because the run already decided it. A `--backend` here would
 * let an operator ask cmux to focus a pane that tmux created, and the honest
 * answer to "which backend is this worker on" is the one recorded at `up`.
 * That file also carries the refs, which is why presentation lives beside
 * state instead of inside it: a lost pane must never invalidate control-plane
 * state.
 */

import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readPresentation } from "../../run/state.ts";
import { loadBackend } from "../../backends/registry.ts";

export function register(program: Command): void {
  program
    .command("attach")
    .description("Focus a worker's pane")
    .option("-w, --worker <id>", "worker id")
    .option("-r, --run <id>", "run id (defaults to the most recent run)")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { worker?: string; run?: string; json?: boolean }) => {
      if (opts.worker === undefined || opts.worker.trim() === "") {
        throw new CliError("attach requires --worker <id>", EXIT.USAGE);
      }
      const root = runsRoot();
      const runId = opts.run ?? (await latestRunId(root));
      if (runId === null) {
        throw new CliError("no runs found", EXIT.USAGE);
      }
      const run = runPaths(runId, root);
      const wp = workerPaths(run, opts.worker);

      const presentation = await readPresentation(wp);
      if (presentation === null) {
        throw new CliError(
          `no presentation record for worker ${opts.worker} in run ${runId}`,
          EXIT.USAGE,
        );
      }

      /**
       * `headless` has no panes at all, and that is a normal configuration
       * rather than an error state — but it must be SAID. Silently succeeding
       * would tell the operator their pane was focused when no pane exists.
       */
      if (presentation.backend === "headless" || presentation.surface_ref === null) {
        throw new CliError(
          `worker ${opts.worker} has no pane to focus (backend: ${presentation.backend})`,
          EXIT.BACKEND_UNAVAILABLE,
        );
      }

      const backend = await loadBackend(presentation.backend);
      await backend.focus({ backend: presentation.backend, id: presentation.surface_ref });

      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify({
            run_id: runId,
            worker: opts.worker,
            backend: presentation.backend,
            pane: presentation.surface_ref,
            focused: true,
          })}\n`,
        );
      } else {
        process.stdout.write(`focused ${opts.worker} (${presentation.backend})\n`);
      }
    });
}
