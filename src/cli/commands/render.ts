import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet render` (SRD §10). */
export function register(program: Command): void {
  program
    .command("render")
    .description("Print the exact docker and pi argv for a worker without spawning")
    .option("-c, --config <path>", "path to fleet.yaml")
    .option("-w, --worker <id>", "worker id")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("render is not implemented yet", EXIT.USAGE);
    });
}
