import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet config` (SRD §10). */
export function register(program: Command): void {
  program
    .command("config <action>")
    .description("Validate the fleet configuration")
    .option("-c, --config <path>", "path to fleet.yaml")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("config is not implemented yet", EXIT.USAGE);
    });
}
