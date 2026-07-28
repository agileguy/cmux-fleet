import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot } from "../../run/paths.ts";
import { collectRunReport } from "../../report/collect.ts";
import { renderRunReport } from "../../report/render.ts";

/**
 * Register `pifleet report` (SRD §10, §14.2): the whole run, for someone who
 * was not watching it.
 *
 * Exit-code stance: nonzero is reserved for failing to PRODUCE a report — no
 * run to report on, or an I/O failure of the tool itself. A run full of
 * failed tasks is a successful report about failure and exits 0; an
 * orchestrator that wants the run's outcome as an integer uses `wait`, whose
 * ladder exists for exactly that. Making `report` fail on bad news would
 * teach callers to skip it precisely when its content matters most.
 */
export function register(program: Command): void {
  program
    .command("report")
    .description("Print a merged run report and merge conflict pre-check")
    .option("--run <id>", "run id")
    .option("--md", "emit markdown (the default human format)")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { run?: string; md?: boolean; json?: boolean }) => {
      const root = runsRoot();
      const runId = opts.run ?? (await latestRunId(root));
      if (runId === null) throw new CliError("no runs found", EXIT.USAGE);
      const run = runPaths(runId, root);

      const { report, notes, attended } = await collectRunReport(run);
      if (opts.json === true) {
        // Collection notes ride ALONGSIDE the RunReportSchema fields, the
        // same convention `artifacts` uses for `harvest_status`: zod strips
        // unknown keys, so a consumer validating the contract still passes
        // while the degradation stays visible in the payload. `attended`
        // rides the same way: a run a person drove must say so in every
        // output format, not only the human one (SRD §3.5, Phase 6).
        process.stdout.write(
          `${JSON.stringify({ ...report, attended, collection_notes: notes })}\n`,
        );
        return;
      }
      process.stdout.write(renderRunReport(report, notes, attended));
    });
}
