import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet transcript` (SRD §10). */
export function register(program: Command): void {
  program
    .command("transcript")
    .description("Export a worker's session transcript")
    .option("-w, --worker <id>", "worker id")
    .option("--html <path>", "write a standalone HTML export")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("transcript is not implemented yet", EXIT.USAGE);
    });
}
