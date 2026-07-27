import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot } from "../../run/paths.ts";
import { startRegistryDaemon } from "../../run/registry.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { readRunHeartbeatIntervalMs } from "../../run/state.ts";

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

      /**
       * The reaper's staleness threshold comes from the run's configured
       * `heartbeat_interval`, not from a constant here — a fleet configured
       * with a slower heartbeat must not be reaped for keeping to it. When no
       * config is reachable (a run directory assembled by a test, or a config
       * since moved) the schema default stands in, which is the same value
       * `up` would have written.
       */
      const heartbeatIntervalMs = await readRunHeartbeatIntervalMs(run);

      const daemon = await startRegistryDaemon(run, {
        onShutdown: () => {
          void ledger
            .append("daemon_stopped", { detail: { pid: process.pid } })
            .finally(() => process.exit(0));
        },
        reaper: {
          heartbeatIntervalMs,
          onReap: (reports) => {
            // Fire-and-forget: a ledger write must never stall the scan loop,
            // but a swallowed rejection here would be an invisible reap.
            for (const r of reports) {
              void ledger
                .append("worker_reaped", {
                  worker: r.worker,
                  detail: { supervisor: r.supervisor, container: r.container },
                })
                .catch((err: unknown) => {
                  process.stderr.write(`ledger: reap of ${r.worker} unrecorded: ${String(err)}\n`);
                });
            }
          },
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
