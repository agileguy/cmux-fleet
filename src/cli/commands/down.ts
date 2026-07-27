import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet down` (SRD §10). */
export function register(program: Command): void {
  program
    .command("down")
    .description("Quiesce the run, stop containers and optionally prune worktrees")
    .option("--run <id>", "run id")
    .option("--keep-panes", "leave panes open")
    .option("--prune", "remove worktrees and branches")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("down is not implemented yet", EXIT.USAGE);
    });
}
