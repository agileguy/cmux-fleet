import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet artifacts` (SRD §10). */
export function register(program: Command): void {
  program
    .command("artifacts")
    .description("Print harvested, adjudicated task artifacts")
    .option("--run <id>", "run id")
    .option("--task <id>", "single task id")
    .option("--all", "every task in the run")
    .option("--include <kinds>", "extra payloads to include, e.g. diff")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("artifacts is not implemented yet", EXIT.USAGE);
    });
}
