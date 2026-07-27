import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot } from "../../run/paths.ts";
import { startRegistryDaemon } from "../../run/registry.ts";
import { LedgerWriter } from "../../run/ledger.ts";

/**
 * Register `pifleet daemon` (SRD §10): the run registry, one per run, started
 * detached by `up` and separately runnable in the foreground for debugging.
 *
 * Deliberately thin (SRD §3.3): it holds no RPC stream and owns no container,
 * so one crash cannot take the fleet. It is the SINGLE writer of
 * `registry.json`; every mutation arrives as a socket RPC.
 */
export function register(program: Command): void {
  program
    .command("daemon")
    .description("Run the run registry and reaper (started by up)")
    .option("--run <id>", "run id")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { run?: string; json?: boolean }) => {
      const root = runsRoot();
      const runId = opts.run ?? (await latestRunId(root));
      if (runId === null) throw new CliError("no runs found", EXIT.USAGE);
      const run = runPaths(runId, root);

      const ledger = new LedgerWriter(run, "daemon");
      await ledger.append("daemon_started", { detail: { pid: process.pid } });

      const daemon = await startRegistryDaemon(run, {
        onShutdown: () => {
          void ledger
            .append("daemon_stopped", { detail: { pid: process.pid } })
            .finally(() => process.exit(0));
        },
      });

      const stop = (): void => {
        void daemon.stop().finally(() => process.exit(0));
      };
      process.on("SIGTERM", stop);
      process.on("SIGINT", stop);

      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify({ run_id: runId, pid: process.pid })}\n`);
      }
      // Foreground forever: the socket server keeps the event loop alive until
      // a shutdown RPC or signal arrives.
      await new Promise(() => {});
    });
}
