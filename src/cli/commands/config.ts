import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { ConfigValidationError, loadConfig } from "../../config/load.ts";

/**
 * Register `pifleet config` (SRD §10).
 *
 * `config validate` exits 2 on ANY failure (ISC-58) and prints field-level
 * errors — the dotted document path plus the message — because "invalid
 * config" without a path is a debugging session, not a diagnostic.
 */
export function register(program: Command): void {
  program
    .command("config <action>")
    .description("Validate the fleet configuration")
    .option("-c, --config <path>", "path to fleet.yaml")
    .option("--json", "emit machine-readable output")
    .action(async (action: string, opts: { config?: string; json?: boolean }) => {
      if (action !== "validate") {
        throw new CliError(`unknown config action "${action}" (expected: validate)`, EXIT.USAGE);
      }
      try {
        const loaded = await loadConfig(opts.config);
        const summary = {
          valid: true,
          path: loaded.path,
          roles: Object.keys(loaded.config.roles),
          workers: loaded.config.workers.map((w) => w.id),
        };
        if (opts.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log(`ok: ${loaded.path}`);
          console.log(`  roles:   ${summary.roles.join(", ")}`);
          console.log(`  workers: ${summary.workers.join(", ")}`);
        }
      } catch (err) {
        if (err instanceof ConfigValidationError) {
          if (opts.json) {
            console.log(JSON.stringify({ valid: false, path: err.file, errors: err.issues }, null, 2));
          }
          // JSON (when asked) went to stdout; the ladder code and human line
          // ride the CliError so the entry point owns process exit.
          throw new CliError(err.message, EXIT.USAGE);
        }
        throw err;
      }
    });
}
