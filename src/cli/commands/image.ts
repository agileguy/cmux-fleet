import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";

/** Register `pifleet image` (SRD §10). */
export function register(program: Command): void {
  program
    .command("image <action>")
    .description("Build, list, verify or garbage-collect worker images")
    .option("--toolchain <name>", "toolchain layer: base|node|python")
    .option("--json", "emit machine-readable output")
    .action(async () => {
      throw new CliError("image is not implemented yet", EXIT.USAGE);
    });
}
