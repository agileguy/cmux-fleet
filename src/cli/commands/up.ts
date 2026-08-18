import type { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { Stopwatch } from "../../rpc/client.ts";
import { newRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readWorkerState, writePresentation } from "../../run/state.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import {
  identityAlive,
  processStartTime,
  registryCall,
  type ProcessIdentity,
} from "../../run/registry.ts";
import { ensureControlAuth } from "../../security/control-auth.ts";
import { writeJsonAtomic } from "../../util/jsonl.ts";
import { resolveBackendWithFallback } from "../../backends/tmux/fallback.ts";
import { isBackendKind, loadBackend } from "../../backends/registry.ts";
import type { PaneRef } from "../../backends/types.ts";
import { makeWorkerAccessible } from "../../container/mounts.ts";
import { processLauncher, supervisorArgv } from "../../supervisor/launch.ts";
import {
  ConfigError,
  assertModelAllowed,
  expandPath,
  parseConfig,
  resolveConfigPath,
  resolveWorker,
  type LoadedConfig,
} from "../../config/load.ts";
import { describeCredentialPlan, planCredential, resolveIdentity } from "../../security/adc.ts";
import { realExec } from "../../container/run.ts";
import { ensureEgressNetwork } from "../../security/network.ts";
import { detectRepoHazards } from "../../security/repo-hazards.ts";
import { DEFAULT_HEARTBEAT_INTERVAL_MS } from "../../config/schema.ts";

/**
 * This CLI's entrypoint, resolved from this module rather than from `cwd`.
 *
 * The pane viewer is spawned as a fresh `pifleet` process, and a pane starts
 * in the worker's directory — a relative path would resolve against that and
 * fail.
 */
const CLI_ENTRY = join(import.meta.dir, "..", "index.ts");

/**
 * Enforce `models_allowlist` across every named worker (ISC-190, ISC-52),
 * before the daemon, before any pane, before any supervisor.
 *
 * The field had been in the schema since v2 with no reader, so the list was
 * documentation: a worker pointed at an unlisted model started exactly as if
 * the operator had listed it. §5.9 makes the allowlist the fleet's statement
 * about which models it has probed for native tool calls, and the whole value
 * of that statement is that it costs a second at `up` rather than an hour of a
 * run that answers in prose.
 *
 * EVERY named worker is checked before ANY is launched. Refusing inside the
 * launch loop would leave a half-started fleet behind the refusal, which is
 * the state the check exists to avoid.
 *
 * A `--workers` id the config does not define is skipped rather than refused:
 * Phase 1 `up` legitimately names ids that exist only as a
 * `PIFLEET_PI_COMMAND` double, and those have no configured model to check.
 * `ModelNotAllowedError` is a `ConfigError`, so it already carries exit 2 and
 * needs no wrapping.
 *
 * That skip is an explicit MEMBERSHIP test, and was a `catch { continue }`
 * around `resolveWorker`. The two are not equivalent. `resolveWorker` raises
 * `ConfigError` for two unrelated conditions — an id absent from `workers:`,
 * and a worker that IS defined but names a role `roles:` does not — and a bare
 * catch cannot tell them apart, so the second was treated as "nothing to check
 * here" and walked straight past the gate. `FleetConfigSchema.superRefine`
 * rejects that config at parse time (ISC-68), which is why the hole was not
 * reachable through `up` in practice; but a guard whose second line of defence
 * silently discards its own errors is not a second line of defence, and the
 * catch would have swallowed any FUTURE resolution failure just as quietly.
 * Anything in `workers:` must resolve, and a failure to resolve propagates
 * exactly as it would without this feature.
 */
export function assertModelsAllowed(loaded: LoadedConfig, workerIds: readonly string[]): void {
  const defined = new Set(loaded.config.workers.map((w) => w.id));
  for (const workerId of workerIds) {
    if (!defined.has(workerId)) continue;
    assertModelAllowed(loaded, resolveWorker(loaded, workerId));
  }
}

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
    .action(async (opts: { workers: string; backend: string; backendFallback?: string; config?: string; json?: boolean }) => {
      if (!isBackendKind(opts.backend)) {
        throw new CliError(
          `unknown backend '${opts.backend}'; expected cmux, tmux or headless`,
          EXIT.USAGE,
        );
      }
      if (opts.backendFallback !== undefined && !isBackendKind(opts.backendFallback)) {
        throw new CliError(
          `unknown fallback backend '${opts.backendFallback}'; expected cmux, tmux or headless`,
          EXIT.USAGE,
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
      /**
       * The harness surface travels with the run for the same reason (ISC-232).
       *
       * `artifacts` and `report` grade this run later, from a run directory
       * and nothing else. If they re-resolved `fleet.yaml` at harvest time
       * they would grade it against whatever config happens to sit in the cwd
       * on the day someone asks — so a task capped by the ISC-150 rule in
       * March certifies `success` in June, purely as a function of where the
       * command was typed. Resolved once, here, at the moment the run is
       * created, and written into `run.json` below.
       *
       * `null` means "config had no opinion, use the built-in defaults" and is
       * written explicitly rather than omitted, so the run states its surface
       * either way instead of leaving a reader to infer it from an absence.
       */
      let harnessPatterns: readonly string[] | null = null;
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
        harnessPatterns = loadedConfig.config.harness.patterns ?? null;
        egressNetwork = loadedConfig.config.docker.network;
        repoRoot = expandPath(loadedConfig.config.run.repo, loadedConfig.dir);

        assertModelsAllowed(loadedConfig, workers);
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
        harness_patterns: harnessPatterns,
      });
      const ledger = new LedgerWriter(run, "cli-up");
      await ledger.append("run_created", { detail: { workers, backend: opts.backend } });
      if (egressNetwork !== null) {
        await ledger.append("egress_network_ready", {
          detail: { network: egressNetwork, internal: egressInternal },
        });
      }

      /**
       * REPORT on the checked-out repository before any worker can read it.
       *
       * A repository is input, and several files in it are read by the agent
       * as INSTRUCTIONS — `AGENTS.md`, `.pi/extensions/`, `core.hooksPath`,
       * MCP configs. A checkout can therefore rewrite the behaviour of the
       * thing grading it with no exploit at all, just a committed file, which
       * is why this runs before the supervisors rather than as part of
       * harvest (SRD §12.2).
       *
       * DETECT, never neutralize, and the distinction is the whole point:
       * `config.run.repo` is the OPERATOR'S working repository, not a
       * disposable per-worker tree. `render.ts` mounts
       * `<repo>/.worktrees/<worker>` as `/workspace`, so the tree a worker
       * actually reads is not this one — and nothing in this phase creates
       * those worktrees yet. Quarantining here therefore defended nothing and
       * damaged the operator: it renamed their real `AGENTS.md` aside and
       * commented out their `filter.lfs.*` definitions while leaving
       * `filter.lfs.required = true` intact, which hard-fails every subsequent
       * `git add` and `checkout` on an LFS-tracked path. SRD §12.8 requires
       * this checkout be left unchanged, and a linked worktree materializes
       * committed files from git objects at checkout time anyway, so renaming
       * in the parent could not have suppressed them.
       *
       * The load-bearing controls are elsewhere and are unaffected: the Pi
       * argv flags (`--no-extensions --no-skills --no-context-files`) and the
       * per-spawn `-c` hardening in `harvest/git.ts`. `repo-hazards.ts` says
       * so itself. Neutralization belongs on the per-worker worktree at the
       * moment it is created — ISC-249 is OPEN until that exists, rather than
       * met by a call aimed at the wrong tree.
       *
       * Every hazard is still recorded, with `detected` and `neutralized` as
       * separate fields precisely so "we saw it and left it" cannot read as
       * "we defused it".
       */
      if (repoRoot !== null) {
        try {
          const hazards = await detectRepoHazards(repoRoot);
          for (const h of hazards) {
            await ledger.append("repo_hazard", {
              detail: { path: h.path, kind: h.kind, neutralized: h.neutralized, detail: h.detail },
            });
          }
          if (hazards.length > 0 && opts.json !== true) {
            process.stdout.write(
              `detected ${hazards.length} repository hazard(s) in ${repoRoot} (reported, NOT modified)\n`,
            );
            for (const h of hazards) {
              process.stderr.write(`  hazard: ${h.kind} at ${h.path}\n`);
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

      /**
       * Presentation, resolved and recorded — never assumed.
       *
       * `--backend` selects what the operator wants to WATCH; it decides
       * nothing about the run. Supervisors are launched detached by
       * `SupervisorLauncher` either way (SRD §3.3), so a backend that cannot
       * start is a cosmetic loss, not a failed fleet — but it must not be a
       * SILENT one. A fallback that quietly swaps cmux for tmux leaves the
       * operator watching panes they believe are cmux, and `resolveBackendWithFallback`
       * therefore writes the switch to stderr AND the ledger before returning.
       *
       * With no `--backend-fallback`, an unavailable primary is exit 3 with a
       * named diagnosis (ISC-131) rather than a silent downgrade to headless:
       * "I asked for six panes and got none, and nothing said so" is the
       * failure this ordering exists to prevent.
       */
      const resolution = await resolveBackendWithFallback({
        primary: await loadBackend(opts.backend),
        ledger,
        ...(opts.backendFallback === undefined
          ? {}
          : { fallback: await loadBackend(opts.backendFallback) }),
      });
      const backend = resolution.backend;
      await ledger.append("backend_ready", {
        detail: {
          requested: opts.backend,
          active: backend.kind,
          fell_back: resolution.fellBack,
          primary_failures: resolution.primaryFailures.map((c) => `${c.name}: ${c.detail ?? ""}`),
        },
      });
      const workspace = await backend.ensureWorkspace(`pifleet-${runId}`);

      const launched: Array<{ id: string; pid: number; pgid: number }> = [];
      /**
       * (pid, start-time) per worker, captured at launch.
       *
       * The readiness gate below needs to tell "this supervisor is idle" from
       * "this supervisor is dead and `state.json` still holds its last words",
       * and a bare pid cannot: the number outlives the process and the kernel
       * hands it out again. Same identity the lease uses (ISC-144).
       */
      const identities = new Map<string, ProcessIdentity>();
      for (const workerId of workers) {
        const wp = workerPaths(run, workerId);
        await mkdir(wp.dir, { recursive: true });
        /**
         * One pane per worker, created BEFORE its supervisor launches so the
         * operator sees the pane fill rather than appear late (ISC-129).
         *
         * Failure here is deliberately not fatal. A pane is presentation, and
         * the supervisor is already detached and backend-independent by
         * design (SRD §3.3) — killing a run because a split failed would make
         * a cosmetic subsystem load-bearing, which is the coupling the two
         * separate interfaces exist to prevent. It is recorded, not swallowed.
         */
        let pane: PaneRef = { backend: backend.kind, id: null };
        try {
          pane = await backend.createPane(workspace, { workerId, cwd: run.root, title: workerId });
        } catch (err) {
          await ledger.append("pane_failed", {
            worker: workerId,
            detail: { backend: backend.kind, error: err instanceof Error ? err.message : String(err) },
          });
          if (opts.json !== true) {
            process.stderr.write(`  no pane for ${workerId}: ${String(err)}\n`);
          }
        }

        // Presentation refs live beside state, never inside it (SRD §7.6).
        // `backend` is the ACTIVE backend, not the requested one: it was
        // hardcoded to "headless" here, so a cmux run recorded itself as
        // headless and `attach` would have had nothing to focus.
        await writePresentation(wp, {
          schema: "pifleet.presentation/v1",
          worker: workerId,
          backend: backend.kind,
          workspace_ref: workspace.id,
          surface_ref: pane.id,
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
        identities.set(workerId, { pid, started: (await processStartTime(pid)) ?? "" });
        await ledger.append("supervisor_launched", {
          worker: workerId,
          detail: { pid, pgid },
        });

        /**
         * Give the pane something to show (ISC-129).
         *
         * The criterion asks for a pane "showing its worker id and live
         * activity", and only the first half was true: the title carried the
         * id while the pane itself ran an idle login shell in the run
         * directory. `attachViewer` — the method `respawn-pane` exists in the
         * required-command list to serve, as `doctor` says in as many words —
         * had no production caller at all, which is the same dead-subsystem
         * shape as `destroy`. A reviewer running a live `up` is what surfaced
         * it; `pane_current_command` was `bash`.
         *
         * `tail -F` and nothing else, deliberately. A pane is a view, never a
         * channel (SRD §3.3): a follower cannot send anything back to the
         * worker, so the operator can watch a run without being able to
         * perturb it from the one surface that is not the control plane.
         * Capital -F rather than -f because neither file need exist yet — it
         * retries instead of dying on the race.
         *
         * `pifleet logs --follow --render` is the viewer, now that the
         * command exists. It replaces a raw `tail -F` over `events.jsonl`
         * and `supervisor.log`, which stood in while `logs` was a stub that
         * threw — a pane is worth more showing legible lines than raw JSONL.
         *
         * The read-only property is what makes this safe to run in a pane,
         * and it is enforced rather than assumed: a test walks the `logs`
         * source and every module it imports and fails if any write API or
         * control-socket path appears. The pane stays a view (SRD §3.3).
         *
         * `--follow` waits for an events file that does not exist yet rather
         * than dying, which matters because the supervisor may not have
         * created it when the pane starts.
         *
         * Failure stays non-fatal for the same reason pane creation is: a
         * missing view must never take down a working run.
         */
        if (pane.id !== null) {
          try {
            /**
             * `env PIFLEET_RUNS_DIR=…` because the pane does NOT inherit this
             * process's environment. Panes are children of a long-lived
             * cmux/tmux server that was started before this run existed, so a
             * viewer relying on the ambient variable would resolve the
             * default `~/.pifleet/runs` and quietly tail the wrong fleet —
             * or nothing at all. `--run` is passed for the same reason:
             * "the most recent run" is a different answer in a stale server.
             */
            await backend.attachViewer(pane, [
              "env",
              `PIFLEET_RUNS_DIR=${root}`,
              process.execPath,
              CLI_ENTRY,
              "logs",
              "--worker",
              workerId,
              "--run",
              runId,
              "--follow",
              "--render",
            ]);
          } catch (err) {
            await ledger.append("viewer_failed", {
              worker: workerId,
              detail: {
                backend: backend.kind,
                error: err instanceof Error ? err.message : String(err),
              },
            });
          }
        }
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

      /**
       * ISC-70: block until every worker is idle, fail loudly otherwise.
       *
       * "Idle" is a claim about a LIVE supervisor, and `phase` alone cannot
       * carry it. `state.json` outlives the process that wrote it, so a
       * supervisor that reached idle and then died — SIGKILL, OOM, a crash on
       * the next tick — leaves a file that reads `idle` forever. This loop
       * would then break, `up` would print the run as ready, and the first
       * command to reach for that worker would fail connecting to a socket
       * nobody is listening on.
       *
       * The liveness test is the (pid, start-time) identity, not `pid` alone:
       * a bare pid check passes the moment the kernel reuses the number, which
       * is the reuse hazard ISC-144 exists to close.
       */
      const clock = new Stopwatch();
      const phases = new Map<string, string>();
      for (;;) {
        let allIdle = true;
        for (const workerId of workers) {
          const identity = identities.get(workerId);
          if (identity !== undefined && !(await identityAlive(identity))) {
            phases.set(workerId, "dead");
            throw new CliError(`worker ${workerId} died during startup`, EXIT.WORKER_DIED);
          }
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
