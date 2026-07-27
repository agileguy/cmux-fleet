import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { ConfigError, loadConfig } from "../../config/load.ts";
import { renderWorker } from "../../config/render.ts";

/** Minimal shell quoting for the human-readable rendering only; --json is exact. */
function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)) return arg;
  return `'${arg.replaceAll("'", `'\\''`)}'`;
}

/**
 * Register `pifleet render` (SRD §10, §6.3).
 *
 * Prints the exact `docker run` argv and the exact `pi` argv for one worker
 * WITHOUT spawning anything (ISC-60). `--json` carries the normalized arrays;
 * the text form is display-only convenience.
 */
export function register(program: Command): void {
  program
    .command("render")
    .description("Print the exact docker and pi argv for a worker without spawning")
    .option("-c, --config <path>", "path to fleet.yaml")
    .requiredOption("-w, --worker <id>", "worker id")
    .option("--run-id <id>", "run id used in names and paths", "dry")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { config?: string; worker: string; runId: string; json?: boolean }) => {
      try {
        const loaded = await loadConfig(opts.config);
        const rendered = await renderWorker(loaded, opts.worker, { runId: opts.runId });
        if (opts.json) {
          console.log(
            JSON.stringify(
              {
                worker: rendered.workerId,
                role: rendered.role,
                run_id: rendered.runId,
                image: rendered.image,
                docker: rendered.docker,
                pi: rendered.pi,
                system_append: rendered.systemAppend
                  ? { host_path: rendered.systemAppend.hostPath, container_path: rendered.systemAppend.containerPath }
                  : null,
              },
              null,
              2,
            ),
          );
          return;
        }
        console.log(`# worker ${rendered.workerId} (role ${rendered.role}), image ${rendered.image}`);
        console.log(rendered.docker.map(shellQuote).join(" "));
        console.log(`# pi argv inside the container`);
        console.log(rendered.pi.map(shellQuote).join(" "));
      } catch (err) {
        if (err instanceof ConfigError) throw new CliError(err.message, EXIT.USAGE);
        throw err;
      }
    });
}
