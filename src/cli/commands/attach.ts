import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet attach` (SRD §10). */
export function register(program: Command): void {
  program
    .command("attach")
    .description("Focus a worker's pane")
    .option("-w, --worker <id>", "worker id")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("attach is not implemented yet", EXIT.USAGE);
    });
}
