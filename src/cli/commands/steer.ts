import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet steer` (SRD §10). */
export function register(program: Command): void {
  program
    .command("steer <message>")
    .description("Inject a mid-turn correction into a worker")
    .option("-w, --worker <id>", "worker id")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("steer is not implemented yet", EXIT.USAGE);
    });
}
