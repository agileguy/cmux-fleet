import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet exec` (SRD §10). */
export function register(program: Command): void {
  program
    .command("exec")
    .description("Run a command inside a worker's container")
    .option("-w, --worker <id>", "worker id")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("exec is not implemented yet", EXIT.USAGE);
    });
}
