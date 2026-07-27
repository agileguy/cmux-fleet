import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet up` (SRD §10). */
export function register(program: Command): void {
  program
    .command("up")
    .description("Build the run directory, worktrees, skill bundles, containers and panes")
    .option("-c, --config <path>", "path to fleet.yaml")
    .option("--workers <ids>", "comma-separated subset of workers")
    .option("--backend <kind>", "cmux|tmux|headless")
    .option("--backend-fallback <kind>", "backend to use if the primary is unavailable")
    .option("--i-know", "proceed despite a detected conflicting workload")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("up is not implemented yet", EXIT.USAGE);
    });
}
