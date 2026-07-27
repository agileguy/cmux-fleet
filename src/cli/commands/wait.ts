import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet wait` (SRD §10). */
export function register(program: Command): void {
  program
    .command("wait")
    .description("Block until tasks settle or a deadline elapses")
    .option("--run <id>", "run id")
    .option("--task <id>", "single task id")
    .option("--all", "wait for every dispatched task")
    .option("--timeout <duration>", "overall timeout, e.g. 25m")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("wait is not implemented yet", EXIT.USAGE);
    });
}
