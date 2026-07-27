import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot } from "../../run/paths.ts";
import { harvestAll, harvestTask, type TaskHarvest } from "../../harvest/index.ts";

/**
 * Serialized form of one task's harvest. The extra keys ride ALONGSIDE the
 * HarvestSchema fields — zod strips unknown keys rather than rejecting them,
 * so consumers validating against HarvestSchema still pass (ISC-88) while
 * `harvest_status` stays in the payload where §8.4 requires it: the exit code
 * is deliberately useless for distinguishing "no artifacts" from "tool broke".
 */
function serialize(t: TaskHarvest): Record<string, unknown> {
  return { ...t.harvest, harvest_status: t.harvestStatus, facts: t.facts };
}

function printHuman(t: TaskHarvest): void {
  const h = t.harvest;
  process.stdout.write(
    `${h.task_id}: verdict=${h.verdict} harvest=${t.harvestStatus} worker=${h.worker} epoch=${h.epoch}\n`,
  );
  for (const r of h.reasons) process.stdout.write(`  reason: ${r}\n`);
  // Discrepancies go at the top of the human report, not buried (F5, §13).
  for (const d of h.discrepancies) process.stdout.write(`  DISCREPANCY: ${d}\n`);
  for (const f of h.derived.files_changed) {
    process.stdout.write(`  ${f.change}: ${f.path}\n`);
  }
}

/**
 * Register `pifleet artifacts` (SRD §8.4, §10).
 *
 * A PURE READ: exit 0 whenever valid JSON was emitted, including for a task
 * that has no artifacts at all — that case is `harvest_status: "unavailable"`
 * in the payload. Nonzero is reserved for usage errors and I/O failures of
 * the tool itself.
 */
export function register(program: Command): void {
  program
    .command("artifacts")
    .description("Print harvested, adjudicated task artifacts")
    .option("--run <id>", "run id")
    .option("--task <id>", "single task id")
    .option("--all", "every task in the run")
    .option("--include <kinds>", "extra payloads to include, e.g. diff")
    .option("--json", "emit machine-readable output")
    .action(
      async (opts: {
        run?: string;
        task?: string;
        all?: boolean;
        include?: string;
        json?: boolean;
      }) => {
        const single = opts.task !== undefined;
        const all = opts.all === true;
        if (single === all) {
          throw new CliError("artifacts requires exactly one of --task or --all", EXIT.USAGE);
        }

        let includeDiff = false;
        for (const kind of (opts.include ?? "").split(",").filter((s) => s.length > 0)) {
          if (kind === "diff") includeDiff = true;
          else throw new CliError(`unknown --include kind: ${kind}`, EXIT.USAGE);
        }

        const root = runsRoot();
        const runId = opts.run ?? (await latestRunId(root));
        if (runId === null) throw new CliError("no runs found", EXIT.USAGE);
        const run = runPaths(runId, root);

        if (single) {
          const t = await harvestTask(run, opts.task as string, { includeDiff });
          if (opts.json === true) process.stdout.write(`${JSON.stringify(serialize(t))}\n`);
          else printHuman(t);
          return;
        }

        // --all: the single end-of-fanout call (§8.4). An empty run emits an
        // empty task list — still valid JSON, still exit 0.
        const tasks = await harvestAll(run, { includeDiff });
        if (opts.json === true) {
          process.stdout.write(`${JSON.stringify({ run_id: runId, tasks: tasks.map(serialize) })}\n`);
        } else {
          process.stdout.write(`run ${runId}: ${tasks.length} task(s)\n`);
          for (const t of tasks) printHuman(t);
        }
      },
    );
}
