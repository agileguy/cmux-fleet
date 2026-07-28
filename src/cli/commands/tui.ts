/**
 * `pifleet tui --worker <id>` (SRD §3.5, §16 Phase 6): hand that worker's
 * pane to a person; `--leave` hands it back.
 *
 * Presentation plane only, like `attach`. The supervisor, container and RPC
 * stream are untouched — dispatch, steer, abort and harvest keep working
 * while the pane is attended, which is the Phase 6 exit criterion ("Dan takes
 * over a pane mid-task; harvest still succeeds").
 *
 * The backend comes from the worker's `presentation.json`, never from a flag,
 * for the same reason `attach` reads it there: the run already decided which
 * backend it is on, and a flag would let an operator ask cmux to respawn a
 * pane tmux owns.
 *
 * The voided-requirements table is printed AT ENTRY, on purpose. The person
 * about to type is the one who most needs to know which guarantees their
 * keystrokes void, and a table that only ever appears in `report` is read
 * after the damage, not before it.
 */

import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readPresentation } from "../../run/state.ts";
import { loadBackend } from "../../backends/registry.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { enterTui, leaveTui } from "../../attended/mode.ts";

export function register(program: Command): void {
  program
    .command("tui")
    .description("Hand a worker's pane to a person (return it with --leave)")
    .option("-w, --worker <id>", "worker id")
    .option("-r, --run <id>", "run id (defaults to the most recent run)")
    .option("--leave", "return the pane to the read-only viewer")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { worker?: string; run?: string; leave?: boolean; json?: boolean }) => {
      if (opts.worker === undefined || opts.worker.trim() === "") {
        throw new CliError("tui requires --worker <id>", EXIT.USAGE);
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
       * `headless` has no pane to hand over, and saying so beats pretending:
       * writing an attended record for a pane that cannot exist would mark a
       * run as human-touched when no hand could have touched it — the inverse
       * of the lie this subsystem prevents, and just as corrosive to trust.
       */
      if (presentation.backend === "headless" || presentation.surface_ref === null) {
        throw new CliError(
          `worker ${opts.worker} has no pane to hand over (backend: ${presentation.backend})`,
          EXIT.BACKEND_UNAVAILABLE,
        );
      }

      const backend = await loadBackend(presentation.backend);
      const pane = { backend: presentation.backend, id: presentation.surface_ref };
      const ledger = new LedgerWriter(run, `cli-tui-${process.pid}`);

      if (opts.leave === true) {
        const record = await leaveTui({
          run,
          workerId: opts.worker,
          backend,
          pane,
          runsRoot: root,
        });
        await ledger.append("tui_left", { worker: opts.worker });
        if (opts.json === true) {
          process.stdout.write(`${JSON.stringify(record)}\n`);
        } else {
          process.stdout.write(
            `${opts.worker} pane returned to the viewer; the run remains marked attended\n`,
          );
        }
        return;
      }

      const record = await enterTui({ run, workerId: opts.worker, backend, pane });
      await ledger.append("tui_entered", {
        worker: opts.worker,
        detail: { voided: record.voided.map((v) => v.isc) },
      });
      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(record)}\n`);
        return;
      }
      const lines = [
        `${opts.worker} pane is now attended (interactive shell in its container)`,
        `${record.voided.length} guarantee(s) are void while a person drives:`,
        ...record.voided.map((v) => `  ${v.isc}: ${v.because}`),
        `hand it back with: pifleet tui --worker ${opts.worker} --leave`,
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    });
}
