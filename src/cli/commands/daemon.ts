import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet daemon` (SRD §10). */
export function register(program: Command): void {
  program
    .command("daemon")
    .description("Run the run registry and reaper (started by up)")
    .option("--run <id>", "run id")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("daemon is not implemented yet", EXIT.USAGE);
    });
}
