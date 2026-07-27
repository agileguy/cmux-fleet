import type { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { Stopwatch } from "../../rpc/client.ts";
import { newRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readWorkerState, writePresentation } from "../../run/state.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { registryCall } from "../../run/registry.ts";
import { writeJsonAtomic } from "../../util/jsonl.ts";
import { createHeadlessBackend } from "../../backends/headless/index.ts";
import { processLauncher, supervisorArgv } from "../../supervisor/launch.ts";

/** ISC-70: every worker reaches `idle` within this budget. */
const IDLE_TIMEOUT_MS = 60_000;
const POLL_MS = 100;

/**
 * Register `pifleet up` (SRD §10): build the run directory, start the daemon
 * and one detached supervisor per worker, and wait for the fleet to go idle.
 *
 * Phase 1 scope: the `headless` backend against the Pi double selected by
 * `PIFLEET_PI_COMMAND`. Config-file resolution and the container path land
 * with the config loader; the worker list comes from `--workers` until then.
 */
export function register(program: Command): void {
  program
    .command("up")
    .description("Build the run directory, worktrees, skill bundles, containers and panes")
    .option("-c, --config <path>", "path to fleet.yaml")
    .option("--workers <ids>", "comma-separated subset of workers", "eng-1")
    .option("--backend <kind>", "cmux|tmux|headless", "headless")
    .option("--backend-fallback <kind>", "backend to use if the primary is unavailable")
    .option("--i-know", "proceed despite a detected conflicting workload")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { workers: string; backend: string; json?: boolean }) => {
      if (opts.backend !== "headless") {
        // Panes are Phase 4. Refusing beats pretending (exit 3, SRD §11).
        throw new CliError(
          `backend '${opts.backend}' is not available in this phase; use --backend headless`,
          EXIT.BACKEND_UNAVAILABLE,
        );
      }
      const piCommand = process.env["PIFLEET_PI_COMMAND"];
      if (piCommand === undefined || piCommand.trim() === "") {
        throw new CliError(
          "PIFLEET_PI_COMMAND is required in Phase 1 (path to the Pi double)",
          EXIT.USAGE,
        );
      }

      const workers = opts.workers
        .split(",")
        .map((w) => w.trim())
        .filter((w) => w.length > 0);
      if (workers.length === 0) throw new CliError("no workers named", EXIT.USAGE);

      const root = runsRoot();
      const runId = newRunId();
      const run = runPaths(runId, root);
      await mkdir(run.root, { recursive: true });
      await mkdir(run.ledgerDir, { recursive: true });
      await mkdir(run.inboxDir, { recursive: true });
      await mkdir(run.sessionsDir, { recursive: true });
      await mkdir(run.workersDir, { recursive: true });

      await writeJsonAtomic(run.runJson, {
        schema: "pifleet.run/v1",
        run_id: runId,
        created_at: new Date().toISOString(),
        backend: opts.backend,
        workers,
      });
      const ledger = new LedgerWriter(run, "cli-up");
      await ledger.append("run_created", { detail: { workers, backend: opts.backend } });

      // The daemon: detached like the supervisors, single writer of registry.json.
      const cliEntry = new URL("../index.ts", import.meta.url).pathname;
      await processLauncher.launchDetached({
        runId,
        runDir: run.root,
        workerId: "@daemon",
        argv: [process.execPath, cliEntry, "daemon", "--run", runId],
        env: { PIFLEET_RUNS_DIR: root },
        logPath: run.daemonLog,
      });

      const backend = createHeadlessBackend();
      await backend.probe();
      const workspace = await backend.ensureWorkspace(`pifleet-${runId}`);

      const launched: Array<{ id: string; pid: number; pgid: number }> = [];
      for (const workerId of workers) {
        const wp = workerPaths(run, workerId);
        await mkdir(wp.dir, { recursive: true });
        // Presentation refs live beside state, never inside it (SRD §7.6).
        await writePresentation(wp, {
          schema: "pifleet.presentation/v1",
          worker: workerId,
          backend: "headless",
          workspace_ref: workspace.id,
          surface_ref: null,
          window_ref: null,
        });
        const { pid, pgid } = await processLauncher.launchDetached({
          runId,
          runDir: run.root,
          workerId,
          argv: supervisorArgv({ runsRoot: root, runId, workerId }),
          env: { PIFLEET_RUNS_DIR: root, PIFLEET_PI_COMMAND: piCommand },
          logPath: wp.supervisorLog,
        });
        launched.push({ id: workerId, pid, pgid });
        await ledger.append("supervisor_launched", {
          worker: workerId,
          detail: { pid, pgid },
        });
      }

      // ISC-70: block until every worker is idle, fail loudly otherwise.
      const clock = new Stopwatch();
      const phases = new Map<string, string>();
      for (;;) {
        let allIdle = true;
        for (const workerId of workers) {
          const state = await readWorkerState(workerPaths(run, workerId));
          const phase = state?.phase ?? "starting";
          phases.set(workerId, phase);
          if (phase === "dead") {
            throw new CliError(`worker ${workerId} died during startup`, EXIT.WORKER_DIED);
          }
          if (phase !== "idle") allIdle = false;
        }
        if (allIdle) break;
        if (clock.elapsedMs() > IDLE_TIMEOUT_MS) {
          const laggards = [...phases.entries()].filter(([, p]) => p !== "idle");
          throw new CliError(
            `workers not idle within ${IDLE_TIMEOUT_MS / 1000}s: ${laggards
              .map(([w, p]) => `${w}=${p}`)
              .join(", ")}`,
            EXIT.TIMEOUT,
          );
        }
        await new Promise((r) => setTimeout(r, POLL_MS));
      }

      await registryCall(run, { cmd: "ping" }, { optional: true });

      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify({ run_id: runId, backend: opts.backend, workers: launched })}\n`,
        );
      } else {
        process.stdout.write(`run ${runId}\n`);
        for (const w of launched) {
          process.stdout.write(`  ${w.id}: supervisor pid ${w.pid} (pgid ${w.pgid}) idle\n`);
        }
      }
    });
}
