import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet harvest` (SRD §10). */
export function register(program: Command): void {
  program
    .command("harvest")
    .description("Rebuild a verdict from the transcript when the envelope is missing")
    .option("-w, --worker <id>", "worker id")
    .option("--reconstruct", "derive the verdict from transcript and diff")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("harvest is not implemented yet", EXIT.USAGE);
    });
}
