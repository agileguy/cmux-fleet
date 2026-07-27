import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet logs` (SRD §10). */
export function register(program: Command): void {
  program
    .command("logs")
    .description("Tail a worker's event stream")
    .option("-w, --worker <id>", "worker id")
    .option("-f, --follow", "stream until interrupted")
    .option("--render", "render the pane viewer view")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("logs is not implemented yet", EXIT.USAGE);
    });
}
