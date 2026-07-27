import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet abort` (SRD §10). */
export function register(program: Command): void {
  program
    .command("abort")
    .description("Cancel a worker's current epoch")
    .option("-w, --worker <id>", "worker id")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("abort is not implemented yet", EXIT.USAGE);
    });
}
