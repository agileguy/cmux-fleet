import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet doctor` (SRD §10). */
export function register(program: Command): void {
  program
    .command("doctor")
    .description("Probe docker/cmux/tmux/pi/git and report backend readiness")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("doctor is not implemented yet", EXIT.USAGE);
    });
}
