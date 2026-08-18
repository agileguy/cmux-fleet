import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot } from "../../run/paths.ts";
import { resolveHarnessPatterns } from "../../harvest/patterns.ts";
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
    .option("-c, --config <path>", "fleet.yaml to read harness.patterns from")
    .option("--md", "emit markdown (the default human format)")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { run?: string; config?: string; md?: boolean; json?: boolean }) => {
      const root = runsRoot();
      const runId = opts.run ?? (await latestRunId(root));
      if (runId === null) throw new CliError("no runs found", EXIT.USAGE);
      const run = runPaths(runId, root);

      // ISC-232: the report's verdicts come from the same harvester
      // `artifacts` uses, so it must read the harness surface from the same
      // place. A run graded one way by one command and another way by the
      // other is not two views of a run, it is a bug with two outputs.
      const harness = await resolveHarnessPatterns(run, opts.config);
      for (const w of harness.warnings) process.stderr.write(`warning: ${w}\n`);

      const collected = await collectRunReport(run, { harnessPatterns: harness.patterns });
      const { report, attended, attendedUnverified } = collected;

      /**
       * The harness notes ride in `collection_notes` as well as on stderr.
       *
       * Stderr alone was invisible to the only consumer `--json` exists for.
       * `pifleet report --run R --json > out.json` in a directory with a
       * broken config regraded against the built-in defaults and wrote a file
       * with no trace of it — a CI gate or dashboard reading the documented
       * contract saw a clean report, and the one signal that a security
       * control had silently reverted went to a stream nobody redirected.
       * This file's own convention (below) is that degradations stay visible
       * IN the payload; the harness note was the one that did not follow it.
       *
       * The surface line is unconditional, not just the failures. `artifacts`
       * publishes what it graded against as `facts.harness.patterns`;
       * `report` had no equivalent field anywhere, so "defaults" and "config"
       * were indistinguishable in its output even when everything worked.
       */
      const notes = [...harness.warnings, harness.surface, ...collected.notes];
      if (opts.json === true) {
        // Collection notes ride ALONGSIDE the RunReportSchema fields, the
        // same convention `artifacts` uses for `harvest_status`: zod strips
        // unknown keys, so a consumer validating the contract still passes
        // while the degradation stays visible in the payload. `attended`
        // rides the same way: a run a person drove must say so in every
        // output format, not only the human one (SRD §3.5, Phase 6).
        process.stdout.write(
          `${JSON.stringify({ ...report, attended, attended_unverified: attendedUnverified, collection_notes: notes })}\n`,
        );
        return;
      }
      process.stdout.write(renderRunReport(report, notes, attended, attendedUnverified));
    });
}
