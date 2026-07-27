import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet dispatch` (SRD §10). */
export function register(program: Command): void {
  program
    .command("dispatch")
    .description("Send task envelopes to workers")
    .option("-w, --worker <id>", "worker id")
    .option("-t, --task <path>", "task envelope file, or - for stdin")
    .option("--auto", "dispatch automatically across idle workers")
    .option("--tasks <path>", "task list for --auto")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("dispatch is not implemented yet", EXIT.USAGE);
    });
}
