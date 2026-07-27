import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet status` (SRD §10). */
export function register(program: Command): void {
  program
    .command("status")
    .description("Print a fleet snapshot")
    .option("--run <id>", "run id")
    .option("--watch", "refresh until interrupted")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("status is not implemented yet", EXIT.USAGE);
    });
}
