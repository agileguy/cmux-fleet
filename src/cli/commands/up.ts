import type { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { Stopwatch } from "../../rpc/client.ts";
import { newRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readWorkerState, writePresentation } from "../../run/state.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { registryCall } from "../../run/registry.ts";
import { ensureControlAuth } from "../../security/control-auth.ts";
import { writeJsonAtomic } from "../../util/jsonl.ts";
import { createHeadlessBackend } from "../../backends/headless/index.ts";
import { makeWorkerAccessible } from "../../container/mounts.ts";
import { processLauncher, supervisorArgv } from "../../supervisor/launch.ts";
import {
  ConfigError,
  expandPath,
  parseConfig,
  resolveConfigPath,
  resolveWorker,
  type LoadedConfig,
} from "../../config/load.ts";
import { describeCredentialPlan, planCredential, resolveIdentity } from "../../security/adc.ts";
import { realExec } from "../../container/run.ts";
import { ensureEgressNetwork } from "../../security/network.ts";
import { neutralizeRepoHazards } from "../../security/repo-hazards.ts";
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "../../config/schema.ts";

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
    .action(async (opts: { workers: string; backend: string; config?: string; json?: boolean }) => {
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
      // `sessions` is bind-mounted rw into every worker, which runs as uid
      // 10001. A Linux bind mount passes host ownership through, so the default
      // 0755 leaves the worker unable to write its own transcript; the macOS VM
      // squashes ownership and hides this entirely.
      await makeWorkerAccessible(run.sessionsDir, true);

      // Mint the run's control-socket secret (SRD §12.7) before launching
      // anything that listens or calls: the daemon and every supervisor read
      // this file, and every control-plane request must carry its value. It
      // is 0600, never mounted into a container, and never logged.
      await ensureControlAuth(run);

      /**
       * The reaper's staleness threshold has to travel WITH the run.
       *
       * The daemon is launched detached, with `PIFLEET_RUNS_DIR` and nothing
       * else — no cwd it can trust and no `--config` to inherit — so it cannot
       * re-resolve `fleet.yaml` later, and a config edited or moved mid-run
       * would in any case give it a threshold the fleet was never started
       * under. Resolved once here and written into the run dir instead.
       *
       * Optional by design: Phase 1 `up` needs no config otherwise, and
       * refusing to start a run because none was found would be a regression.
       * The fallback is the schema's own default, which is the value a config
       * that omitted the key would have produced anyway.
       */
      let heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
      let egressNetwork: string | null = null;
      let repoRoot: string | null = null;
      let loadedConfig: LoadedConfig | null = null;

      /**
       * Resolution and loading are two DISTINCT steps here because their
       * failures mean opposite things, and only resolution can tell them
       * apart.
       *
       * "No config anywhere" is the legitimate Phase 1 shape above — the
       * schema defaults stand. But a config that RESOLVED and then failed to
       * load (unreadable, malformed YAML, schema violation) must refuse to
       * start: `docker.network` and `run.repo` come from that file, so
       * "could not load it, carried on" IS "no egress network verified, no
       * repository hazard scan", silently — a one-character typo in
       * fleet.yaml produced an unhardened run indistinguishable from a
       * hardened one (review finding 1; a bare catch conflated all three
       * failure classes). An explicit `--config` that does not resolve
       * refuses for the same reason: the operator named a file and did not
       * get it, and defaults would wear the shape of the config they asked
       * for.
       */
      let configPath: string | null = null;
      try {
        configPath = await resolveConfigPath(opts.config);
      } catch (err) {
        if (opts.config !== undefined || !(err instanceof ConfigError)) {
          throw new CliError(err instanceof Error ? err.message : String(err), EXIT.USAGE);
        }
        // Implicit resolution found nothing; the schema defaults stand.
      }
      if (configPath !== null) {
        try {
          loadedConfig = await parseConfig(await Bun.file(configPath).text(), configPath);
        } catch (err) {
          throw new CliError(
            `refusing to start: config ${configPath} exists but could not be loaded — ` +
              `the egress network and repository hazard scan are configured there, so ` +
              `proceeding would run unhardened. ${err instanceof Error ? err.message : String(err)}`,
            EXIT.USAGE,
          );
        }
        heartbeatIntervalMs = loadedConfig.config.run.timers.heartbeat_interval * 1000;
        egressNetwork = loadedConfig.config.docker.network;
        repoRoot = expandPath(loadedConfig.config.run.repo, loadedConfig.dir);
      }

      /**
       * The egress network must exist, and must be INTERNAL, before any
       * container is attached to it.
       *
       * `render.ts` already puts every worker on `docker.network`, so the
       * attachment was never the gap — creation was. An absent network makes
       * `docker run` fail, which is loud and fine. A network of that name that
       * someone created WITHOUT `--internal` is the dangerous case: every
       * worker gets unrestricted egress while the fleet reports deny-all, and
       * nothing anywhere would say so. `ensureEgressNetwork` refuses to adopt
       * one rather than quietly using it (SRD §5.6, §12).
       */
      let egressInternal: boolean | null = null;
      if (egressNetwork !== null) {
        try {
          egressInternal = (await ensureEgressNetwork(egressNetwork)).internal;
        } catch (err) {
          throw new CliError(String(err), EXIT.BACKEND_UNAVAILABLE);
        }
      }

      await writeJsonAtomic(run.runJson, {
        schema: "pifleet.run/v1",
        run_id: runId,
        created_at: new Date().toISOString(),
        backend: opts.backend,
        workers,
        heartbeat_interval_ms: heartbeatIntervalMs,
      });
      const ledger = new LedgerWriter(run, "cli-up");
      await ledger.append("run_created", { detail: { workers, backend: opts.backend } });
      if (egressNetwork !== null) {
        await ledger.append("egress_network_ready", {
          detail: { network: egressNetwork, internal: egressInternal },
        });
      }

      /**
       * Neutralize the checked-out repository BEFORE any worker can read it.
       *
       * A repository is input, and several files in it are read by the agent
       * as INSTRUCTIONS — `AGENTS.md`, `.pi/extensions/`, `core.hooksPath`,
       * MCP configs. A checkout can therefore rewrite the behaviour of the
       * thing grading it with no exploit at all, just a committed file, which
       * is why this runs before the supervisors rather than as part of
       * harvest (SRD §12.2).
       *
       * Every hazard is recorded whether or not it was defused: `detected`
       * and `neutralized` are separate fields precisely so "we saw it and
       * left it" cannot read as "we defused it", and a worker whose
       * legitimate AGENTS.md was moved must be able to find out why.
       */
      if (repoRoot !== null) {
        try {
          const hazards = await neutralizeRepoHazards(repoRoot);
          for (const h of hazards) {
            await ledger.append("repo_hazard", {
              detail: { path: h.path, kind: h.kind, neutralized: h.neutralized, detail: h.detail },
            });
          }
          if (hazards.length > 0 && opts.json !== true) {
            const undefused = hazards.filter((h) => !h.neutralized).length;
            process.stdout.write(
              `neutralized ${hazards.length - undefused}/${hazards.length} repository hazard(s)\n`,
            );
            for (const h of hazards.filter((x) => !x.neutralized)) {
              process.stderr.write(`  NOT neutralized: ${h.kind} at ${h.path}\n`);
            }
          }
        } catch (err) {
          // The scan failing is an environment problem (unreadable repo,
          // permissions), not an operator mistake — `2` misfiled it as usage
          // (review finding 4). `3` matches the egress guard above, which is
          // the same failure class: a configured control that could not be
          // established, refusing rather than proceeding without it.
          throw new CliError(`repository hazard scan failed: ${String(err)}`, EXIT.BACKEND_UNAVAILABLE);
        }
      }

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

      /**
       * The Google grant is never silent (SRD §5.8).
       *
       * Per worker, one line saying what identity it got or that it got none.
       * `cloud_access: false` produces a `none` PLAN rather than an early
       * return, so "this worker has no credential" is a statement the run
       * makes rather than something an operator has to infer from the absence
       * of any mention.
       *
       * Planning only. Minting and the refresh loop attach to a running
       * container, and the headless path does not start one — wiring them to
       * a container that does not exist would be wiring to nothing. Tracked as
       * ISC-248 rather than faked.
       */
      if (loadedConfig !== null) {
        const cfg = loadedConfig;
        const cloud = cfg.config.cloud;
        const plans = workers.map((workerId) => {
          let cloudAccess = false;
          try {
            cloudAccess = resolveWorker(cfg, workerId).cloudAccess;
          } catch {
            // Worker not in config (Phase 1 --workers can name any id).
          }
          return {
            workerId,
            plan: planCredential({
              cloudAccess,
              adcMode: cloud.adc_mode,
              impersonateServiceAccount: cloud.impersonate_service_account,
              quotaProject: cloud.quota_project,
            }),
          };
        });

        /**
         * ISC-251 says the grant line names the identity each worker was
         * GIVEN — and without impersonation that identity is the host's
         * gcloud account, which `describeCredentialPlan` cannot know on its
         * own. Its "(adc user)" fallback is a placeholder wearing the shape
         * of an answer, and printing it unconditionally overclaimed the ISC
         * (review finding 3). `resolveIdentity` reads local gcloud config —
         * no network round-trip, no token minting — so being truthful costs
         * one subprocess, paid only when some worker's plan actually injects
         * as the ADC user. Resolution failing (no gcloud on the host, no
         * account configured) degrades to the placeholder with a note on
         * stderr rather than failing `up`: in Phase 1 the plan is a
         * statement, not a mint, and a missing gcloud is loud enough at the
         * first real mint.
         */
        let adcIdentity: string | undefined;
        if (plans.some((p) => p.plan.kind === "inject" && p.plan.impersonateServiceAccount === null)) {
          try {
            adcIdentity = await resolveIdentity(realExec, null);
          } catch (err) {
            process.stderr.write(
              `note: could not resolve the host gcloud account for the credential plan: ` +
                `${err instanceof Error ? err.message : String(err)}\n`,
            );
          }
        }

        for (const { workerId, plan } of plans) {
          const line = describeCredentialPlan(plan, adcIdentity);
          await ledger.append("credential_plan", { worker: workerId, detail: { plan: line } });
          if (opts.json !== true) process.stdout.write(`  ${workerId}: ${line}\n`);
        }
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
