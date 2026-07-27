import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet report` (SRD §10). */
export function register(program: Command): void {
  program
    .command("report")
    .description("Print a merged run report and merge conflict pre-check")
    .option("--run <id>", "run id")
    .option("--md", "emit markdown")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("report is not implemented yet", EXIT.USAGE);
    });
}
