import type { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { Stopwatch } from "../../rpc/client.ts";
import { newRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { materializeWorkerInputs } from "../../run/materialize.ts";
import { readWorkerState, runBudgetRecord, writePresentation } from "../../run/state.ts";
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
import { assertImagesReady, requiredImages } from "../../container/image.ts";
import { renderAllWorkers } from "../../config/render.ts";
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
import { assertModelsSupportToolCalls } from "../../security/model-probe.ts";
import { containerFetch } from "../../security/probe-transport.ts";
import { checkMlxTrainingGuard, describeMatch } from "../../safety/mlx-training-guard.ts";
import { ensureEgressRelay, type RelayStatus } from "../../security/relay.ts";
import { detectRepoHazards, neutralizeRepoHazards } from "../../security/repo-hazards.ts";
import { captureWorktreeBaseline, createWorkerWorktrees, type WorkerWorktree } from "../../run/worktree.ts";
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
 * The backend `up` selects when NOTHING says otherwise.
 *
 * Named rather than inlined as a commander default, because "nobody said
 * anything" and "the operator typed `--backend headless`" have to be
 * distinguishable for a config to ever get a say (ISC-271). A commander
 * default destroys that distinction before the action body runs.
 *
 * `headless` and not the schema's `cmux`: this is the value that has to hold
 * on a machine with no terminal multiplexer at all, and it is the one every
 * run in this repository has been getting.
 */
const DEFAULT_BACKEND = "headless";

/**
 * Register `pifleet up` (SRD §10): build the run directory, start the daemon
 * and one detached supervisor per worker, and wait for the fleet to go idle.
 *
 * THE LAUNCH SET COMES FROM `workers:` (ISC-61), and `--workers` narrows it.
 *
 * `--workers` used to carry the commander default `"eng-1"`, which made the
 * container count a function of ARGV and nothing else: `up --backend headless
 * --json` with no flag launched exactly one worker called `eng-1` whether or
 * not any config defined it, and `--workers a1,b2,c3` launched three ids no
 * config defined. Editing `workers:` therefore changed nothing about a run —
 * the criterion said the opposite, and was graded `[x]` on a test that called
 * `renderAllWorkers` directly rather than on anything `up` did.
 *
 * The default is now `undefined`, and an absent flag means "every worker the
 * config declares". `--workers` keeps its Phase 1 meaning EXACTLY: an explicit
 * operator override that may name ids the config does not define, because a
 * `PIFLEET_PI_COMMAND` double run legitimately names ids that exist nowhere but
 * on the command line, and most of this repo's integration suite runs that way.
 * What changed is only which set you get when you say nothing.
 *
 * That narrows, rather than widens, the reach of `assertModelsAllowed`'s
 * membership skip below: on the default path every id came FROM `workers:`, so
 * the `continue` for an undefined id is unreachable and every worker is checked.
 * It stays reachable only for ids an operator typed by hand.
 */
export function register(program: Command): void {
  program
    .command("up")
    .description("Build the run directory, worktrees, skill bundles, containers and panes")
    .option("-c, --config <path>", "path to fleet.yaml")
    .option("--workers <ids>", "comma-separated subset of workers (default: every worker in workers:)")
    .option("--backend <kind>", `cmux|tmux|headless (default: ${DEFAULT_BACKEND})`)
    .option("--backend-fallback <kind>", "backend to use if the primary is unavailable")
    .option("--i-know", "proceed despite a detected conflicting workload")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { workers?: string; backend?: string; backendFallback?: string; config?: string; json?: boolean; iKnow?: boolean }) => {
      /**
       * `--backend` carries NO commander default any more (ISC-271, and the
       * same shape as ISC-61 one option up).
       *
       * Commander cannot tell "the operator typed `--backend headless`" from
       * "nobody said anything" once a default has been substituted, and that
       * inability was the whole defect: the literal `"headless"` default beat
       * every config unconditionally, so a `fleet.yaml` setting `backend.kind`
       * was silently overridden and nothing anywhere said so. `undefined` now
       * means silence, and the fallback is applied ONCE, at the selection
       * point below, where a config could be consulted between the two.
       *
       * BEHAVIOUR IS UNCHANGED BY THIS COMMIT, deliberately — see the comment
       * at `requestedBackend`. What changes is that the missing input has a
       * named seam instead of being spread across an option default.
       */
      if (opts.backend !== undefined && !isBackendKind(opts.backend)) {
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

      /**
       * Refuse while an MLX training run is active, unless `--i-know` (ISC-56).
       *
       * Here, among the cheap refusals, and BEFORE the run directory exists:
       * §5.9 records this machine turning an OOM under concurrent heavy GPU
       * load into a kernel watchdog panic, so the whole value of the check is
       * that it costs nothing and happens before anything is on disk to clean
       * up. Detection is a documented HEURISTIC (see the guard module) — it
       * catches the common `mlx_lm.lora`-shaped accident and cannot see a
       * bespoke training script, which is exactly why the override exists.
       *
       * `EXIT.BACKEND_UNAVAILABLE`, not `USAGE`: nothing is wrong with the
       * command line, the host is busy. Same class as the egress-network and
       * hazard-scan refusals below.
       */
      const mlxTraining = await checkMlxTrainingGuard();
      if (mlxTraining.length > 0 && opts.iKnow !== true) {
        throw new CliError(
          `refusing to start: ${mlxTraining.length} MLX training process(es) appear to be ` +
            `running, and a fleet's concurrent GPU load has panicked this host before ` +
            `(SRD §5.9)\n${mlxTraining.map((m) => `  ${describeMatch(m)}`).join("\n")}\n` +
            `Wait for the run to finish, or pass --i-know to proceed anyway`,
          EXIT.BACKEND_UNAVAILABLE,
        );
      }
      if (mlxTraining.length > 0) {
        // Overridden, not absent. An operator who chose to race a training run
        // must leave a trace of that choice: this goes to stderr NOW (the
        // ledger does not exist for another ~170 lines, and a warning that
        // arrives after the decision is not a warning) and is appended to the
        // ledger below, so the record survives the terminal scrollback.
        process.stderr.write(
          `warning: --i-know overrode the MLX training guard; ${mlxTraining.length} ` +
            `training process(es) are still running:\n` +
            `${mlxTraining.map((m) => `  ${describeMatch(m)}`).join("\n")}\n`,
        );
      }

      /**
       * `--workers`, parsed but NOT yet defaulted (ISC-61).
       *
       * `null` means the flag was absent, which is a different statement from
       * "the flag named nothing" and resolves to a different launch set: the
       * config's whole `workers:` list, decided below once the config has
       * actually loaded. An empty flag (`--workers ""`, `--workers ,,`) is an
       * operator who meant to name workers and named none, and is refused HERE
       * — before the run directory exists — because it can be.
       *
       * Deduped, and not merely as tidiness. A repeated id is a plain typo
       * (`--workers eng-1,eng-1`), and every stage below treats the list as a
       * set of distinct workers: it would launch two supervisors for one id
       * against one control socket, materialize one worker's inputs twice, and
       * wait on the same state file under two names. `[...new Set()]` keeps
       * first-seen order, so nothing else about the list changes. The config
       * path needs no dedupe of its own — `workers.*.id` uniqueness is a schema
       * refusal (ISC-68) — but it costs nothing to run both through one set.
       */
      const namedWorkers =
        opts.workers === undefined
          ? null
          : [
              ...new Set(
                opts.workers
                  .split(",")
                  .map((w) => w.trim())
                  .filter((w) => w.length > 0),
              ),
            ];
      if (namedWorkers !== null && namedWorkers.length === 0) {
        throw new CliError("no workers named: --workers was given but names no worker", EXIT.USAGE);
      }
      /**
       * The launch set. Filled from `workers:` at config load when `--workers`
       * was absent; `let` rather than `const` for exactly that one assignment.
       */
      let workers: string[] = namedWorkers ?? [];

      /**
       * Whether this run uses the Pi DOUBLE instead of containers.
       *
       * Read once, here, and consumed twice: by the image gate below and by
       * `materializeWorkerInputs`'s `writeLaunchRecord` further down. It used to
       * be computed only at the second of those. Two independent readings of one
       * environment variable are two things that can disagree after an edit, and
       * "the gate thought we were launching containers while materialization
       * thought we were not" is a disagreement that would show up as a refusal
       * on a run that needed no image at all.
       */
      const useDouble = (process.env["PIFLEET_PI_COMMAND"] ?? "").trim() !== "";

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
      /**
       * `PIFLEET_PI_COMMAND` is required only when there is NO config.
       *
       * It used to be checked at the top of the action, before config
       * resolution — which was right while the double was the only way to run
       * anything, and became wrong the moment a config could produce a launch
       * record. A configured fleet launches containers and never reads this
       * variable; demanding it anyway would refuse every real run for want of
       * a test seam.
       *
       * The check is not DELETED, because the config-less path is still real:
       * `up --workers eng-1` with no `fleet.yaml` reachable is how most of
       * this repo's integration suite runs, and there the double is the only
       * thing that can be spawned. So the requirement follows the case it
       * belongs to instead of standing in front of both.
       */
      if (configPath === null) {
        const piCommand = process.env["PIFLEET_PI_COMMAND"];
        if (piCommand === undefined || piCommand.trim() === "") {
          throw new CliError(
            "no fleet.yaml was found and PIFLEET_PI_COMMAND is unset — pifleet has nothing to " +
              "launch. Point --config at a fleet.yaml to run containers, or set " +
              "PIFLEET_PI_COMMAND to the Pi double.",
            EXIT.USAGE,
          );
        }
        /**
         * No config AND no `--workers` is the one shape with no launch set at
         * all (ISC-61).
         *
         * It used to be answered by the commander default `"eng-1"` — a
         * hard-coded id that made the count argv-shaped forever. With that
         * default gone, this case has to say so out loud rather than launch
         * something nobody named. Refused HERE, beside the other config-less
         * requirement, because they are the same sentence: there is no file to
         * take a default from, so the command line has to carry it.
         */
        if (namedWorkers === null) {
          throw new CliError(
            "no workers named: with no fleet.yaml there is no workers: list to default to — " +
              "pass --workers, or point --config at a fleet.yaml.",
            EXIT.USAGE,
          );
        }
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

        /**
         * THE LAUNCH SET, when `--workers` did not name one (ISC-61).
         *
         * This single line is what makes the container count a function of
         * `workers:`. Everything downstream — worktree creation, input
         * materialization, the supervisor loop, the credential plan, the idle
         * gate and the `--json` worker array — already iterates `workers`, so
         * one worker per `workers:` entry falls out of it with no further
         * wiring. `renderWorker` is called once per id by
         * `materializeWorkerInputs`, which is why N entries produce N rendered
         * containers.
         *
         * Assigned AFTER the parse and BEFORE `assertModelsAllowed`, which is
         * the only ordering that works: the gate below has to see the real set.
         * `workers.*.id` is schema-unique (ISC-68), so this cannot introduce a
         * duplicate, and `workers:` is `.min(1)`, so it cannot be empty.
         */
        if (namedWorkers === null) {
          workers = loadedConfig.config.workers.map((w) => w.id);
        }

        /**
         * ISC-52 — a config-vs-config comparison, so it runs at the earliest
         * possible moment.
         *
         * Its twin, the ISC-53 native-tool-call probe, USED to be the very
         * next line. It is now further down, after the egress network and the
         * relay, and the reason is ISC-260 — see the comment at that call.
         */
        assertModelsAllowed(loadedConfig, workers);

        /**
         * EVERY ROLE'S IMAGE MUST EXIST AND MUST VERIFY (ISC-32, ISC-189).
         *
         * Here, beside `assertModelsAllowed`, and for the identical reason that
         * gate gives: before the daemon, before any pane, before any
         * supervisor, and — the part that distinguishes this criterion from the
         * behaviour it replaces — before the first CLONE.
         *
         * WHAT USED TO HAPPEN WITH A MISSING IMAGE, because "refuses to start"
         * and what shipped are not the same event. `up` created the run
         * directory, cloned a checkout per worker, registered a remote per
         * worker IN THE OPERATOR'S OWN REPOSITORY, materialized every input and
         * launched every supervisor; the dead child then surfaced at the idle
         * gate ~600 lines later as `worker <id> died during startup` with
         * `EXIT.WORKER_DIED`, leaving the whole run's state on disk to be
         * reaped. Different exit code, different diagnosis, different cleanup.
         *
         * THE TAGS COME FROM THE RENDERER, not from a second call to
         * `imageTag`. `renderAllWorkers` is the function that writes the tag
         * into the `docker run` argv `materializeWorkerInputs` will record and
         * the supervisor will spawn, so gating on its output is gating on the
         * bytes this run will actually use. A gate that recomputed the tag
         * could pass while the launch used a different one, which is a worse
         * failure than no gate: it would certify the wrong image.
         *
         * SKIPPED ON THE DOUBLE, and this is not a hole. `PIFLEET_PI_COMMAND`
         * is the documented statement "run this instead of the real thing";
         * `up` starts NO container on that path (see `writeLaunchRecord`
         * below), so there is no image for the gate to be about. Demanding one
         * would refuse every test double in this repo for want of a build.
         *
         * IDS THE CONFIG DOES NOT DEFINE are skipped, by the same membership
         * rule and the same `defined` set `assertModelsAllowed` uses — an id
         * that exists only on the command line has no role, no toolchain and
         * therefore no image to check. On the DEFAULT path that filter removes
         * nothing, because every id came from `workers:`; it only bites when an
         * operator typed `--workers` by hand, which is the case Phase 1 keeps
         * deliberately open.
         */
        if (!useDouble) {
          const definedIds = new Set(loadedConfig.config.workers.map((w) => w.id));
          const gated = workers.filter((id) => definedIds.has(id));
          const rendered = await renderAllWorkers(loadedConfig, { runId }, gated);
          await assertImagesReady(
            requiredImages(
              rendered.map((r) => ({
                workerId: r.workerId,
                role: r.role,
                toolchain: r.toolchain,
                image: r.image,
              })),
            ),
            loadedConfig.config.docker.pi_version,
            {
              onReady: (img) => {
                // Said out loud, because a control nobody can see is one an
                // operator cannot tell apart from one that did not run. Not on
                // the `--json` path: that stream carries one object.
                if (opts.json !== true) {
                  process.stdout.write(
                    `  image ${img.tag} present and verified (${img.roles.join(", ")})\n`,
                  );
                }
              },
            },
          );
        }
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
          // `err.message` rather than `String(err)`: these errors already
          // begin "egress: " / "relay: ", and `String(err)` prepends
          // "Error: " so the operator reads "Error: relay: …".
          throw new CliError(err instanceof Error ? err.message : String(err), EXIT.BACKEND_UNAVAILABLE);
        }
      }

      /**
       * …and the relay that reopens exactly one destination through it.
       *
       * The internal bridge denies the fleet's own model server along with
       * everything else, so without this every worker starts healthy and
       * accomplishes nothing — §5.9's quiet-failure shape exactly. The relay
       * is a durable, shared resource: `ensureEgressRelay` adopts a running
       * one unchanged, and `down` never tears it down, for the same reason it
       * never removes the egress network.
       *
       * It forwards oMLX ONLY. The Google endpoints in `egress.google_hosts`
       * remain policy-level allow rules with no live relay path (ISC-253);
       * a `cloud_access` worker on this bridge still cannot reach them.
       */
      let egressRelay: RelayStatus | null = null;
      if (egressNetwork !== null && loadedConfig !== null) {
        try {
          egressRelay = await ensureEgressRelay(loadedConfig.config, egressNetwork);
        } catch (err) {
          // `err.message` rather than `String(err)`: these errors already
          // begin "egress: " / "relay: ", and `String(err)` prepends
          // "Error: " so the operator reads "Error: relay: …".
          throw new CliError(err instanceof Error ? err.message : String(err), EXIT.BACKEND_UNAVAILABLE);
        }
      }

      /**
       * ISC-53, the second half of §5.9's model gate — asked FROM INSIDE the
       * egress network (ISC-260).
       *
       * ISC-52 above asked "is this model on the list the operator vouched
       * for". This asks the server "can this model actually emit a native tool
       * call", and both run over EVERY named worker before ANY supervisor
       * launches, for the same reason: a refusal partway through the launch
       * loop leaves a half-started fleet behind it.
       *
       * ## Why it is HERE and not next to its twin
       *
       * It used to be the line after `assertModelsAllowed`, roughly eighty
       * lines above, and it probed with the host's own `fetch`. Workers do not
       * have the host's `fetch`. They reach oMLX from inside `docker.network`,
       * an `--internal` bridge with no default route, where
       * `host.docker.internal` resolves to the egress relay because the relay
       * puts that alias there — and where nothing resolves before the relay
       * exists.
       *
       * So the probe cannot run until the bridge and the relay are up, which
       * is what the two blocks above do. The ordering is not a preference; it
       * is the precondition for the probe testing anything real.
       *
       * The old position looked safer and was not. Probing from the host meant
       * the gate certified a path no worker uses, via a hostname rewrite that
       * quietly turned the worker-facing URL into `localhost` — invisible only
       * because a Docker-host-local oMLX happens to answer on both. Move oMLX
       * off this box and the gate passes while every worker is denied, which
       * is the runtime failure §5.9 makes the probe mandatory to prevent.
       *
       * ## What is still true
       *
       * Nothing below has started. `run.json`, the ledger and every supervisor
       * come after this point, so a refusal here leaves the same "nothing
       * launched" state it always did — which is what `up-wiring.test.ts`
       * asserts, and why this sits BEFORE the run document rather than merely
       * before the launch loop.
       *
       * A model that answers in prose exits 2 (a usage error — the wrong model
       * was named); oMLX being unreachable exits 3 (an environment failure —
       * nothing was learned about the model). Both codes come off the thrown
       * error's own `exitCode` via the `ExitCoded` protocol.
       */
      if (loadedConfig !== null && egressNetwork !== null) {
        await assertModelsSupportToolCalls(
          loadedConfig,
          workers,
          containerFetch({ network: egressNetwork }),
        );
      }

      /**
       * ONE document object, written more than once.
       *
       * `run.json` has to exist before anything else so a run that refuses
       * halfway is still a readable run directory — but the per-worker
       * checkouts below do not exist yet and are recorded AS they are created
       * (see the `onCreated` callback). Mutating and re-writing this object is
       * what keeps the two writes from becoming two spellings of the same
       * document, which is the divergence `run/paths.ts`'s first rule exists
       * to prevent. Nothing detached is running at either write.
       *
       * `worktrees: null` rather than `[]` at this point, and the distinction
       * is load-bearing for `down --prune`: `[]` is the legitimate final state
       * of a fleet where no worker uses `worktree` isolation, while `null`
       * means creation never completed. Only one of those should read as
       * "there is nothing on disk to reap".
       */
      /**
       * THE ONE PLACE THE BACKEND IS CHOSEN (ISC-271).
       *
       *     explicit --backend  >  the config's backend.kind  >  DEFAULT_BACKEND
       *
       * All three terms are now here. The middle one was absent until the
       * schema could express it, and the reason is worth keeping: while
       * `BackendSchema.kind` carried `.default("cmux")` these three documents
       * parsed to BYTE-IDENTICAL `config.backend` objects, all three carrying
       * `kind: "cmux"` —
       *
       *     (no backend: block at all)
       *     backend: {}
       *     backend: {kind: cmux}
       *
       * — so consuming it would not have honoured the configs that SET `kind`.
       * It would have forced cmux onto every `fleet.yaml` in existence,
       * turning every run on a cmux-less host into exit 3 via
       * `resolveBackendWithFallback`. That is a silent SCHEMA-default override
       * replacing a silent FLAG-default override: the defect relocated, not
       * removed.
       *
       * `kind` is now `.optional()`, so an absent block means UNSET and this
       * expression can read it. Both halves are mutation-proved: un-wiring
       * this line turns the config-honoured test red (`Expected "cmux",
       * Received "headless"`), and restoring `.default("cmux")` in the schema
       * turns the no-backend-block test red (`Expected "headless", Received
       * "cmux"`) — the blast radius above, caught rather than described.
       *
       * The witness is `run.json`'s `backend`, written from `requestedBackend`
       * BELOW, before `resolveBackendWithFallback`. `--json`'s `backend`
       * reports what was RESOLVED, which depends on what the host can run, so
       * it cannot grade this criterion portably.
       *
       * NOT FIXED HERE, and named so it is filed rather than forgotten:
       * `workspace`, `split` and `focus_on_dispatch` in the same
       * `BackendSchema` block still have no config reader anywhere. Wiring
       * `kind` alone leaves three documented options that change nothing.
       */
      const configBackend: "cmux" | "tmux" | "headless" | null = loadedConfig?.config.backend.kind ?? null;
      const requestedBackend = opts.backend ?? configBackend ?? DEFAULT_BACKEND;

      const runDoc: Record<string, unknown> = {
        schema: "pifleet.run/v1",
        run_id: runId,
        created_at: new Date().toISOString(),
        backend: requestedBackend,
        workers,
        heartbeat_interval_ms: heartbeatIntervalMs,
        harness_patterns: harnessPatterns,
        // The parent checkout travels with the run for the same reason the
        // harness surface does: `down --prune` removes remotes from THIS
        // repository, and re-resolving `fleet.yaml` months later could point
        // that at a different one. `branch_prefix` travels for the same
        // reason one level further: `dispatch`'s fallback for a worker with
        // no checkout of its own to read a branch off (`shared-ro`, `none`)
        // has to name what THIS run was launched with, not whatever
        // `fleet.yaml` says today.
        repo: repoRoot,
        branch_prefix: loadedConfig?.config.run.branch_prefix ?? null,
        /**
         * What the run may SPEND, recorded for the same reason as everything
         * above it: `dispatch --auto` caps concurrency and halts on the
         * ceiling using these numbers, and re-resolving `fleet.yaml` at
         * dispatch time would budget a months-old run against whatever config
         * sits in today's cwd.
         *
         * `max_concurrent` had NO reader anywhere before the budget reached
         * the dispatch path — a config key that validated, documented itself
         * in `fleet.example.yaml`, and changed nothing, exactly like
         * `branch_prefix` one line above. Null here means "no config was
         * reachable", which `readRunBudgetPolicy` answers with the schema's
         * own default for the cap and with UNBOUNDED for the ceiling; the two
         * defaults differ on purpose, because a cap only delays work while an
         * invented ceiling would refuse work nobody budgeted for.
         */
        ...runBudgetRecord(loadedConfig?.config.run ?? null),
        worktrees: null,
      };
      await writeJsonAtomic(run.runJson, runDoc);
      const ledger = new LedgerWriter(run, "cli-up");
      await ledger.append("run_created", { detail: { workers, backend: requestedBackend } });
      // The durable half of the `--i-know` override warned about above: a run
      // that raced a training run must say so in its own record, so `report`
      // can explain a panicked host months later.
      if (mlxTraining.length > 0) {
        await ledger.append("mlx_training_guard_overridden", {
          detail: { matches: mlxTraining.map((m) => ({ pid: m.pid, command: m.command })) },
        });
      }
      if (egressNetwork !== null) {
        await ledger.append("egress_network_ready", {
          detail: { network: egressNetwork, internal: egressInternal },
        });
      }
      if (egressRelay !== null) {
        /**
         * `script_sha256` and `targets` are recorded on EVERY run, adopted or
         * created, and that is the point rather than an accident.
         *
         * The relay executes a bind-mounted file from the operator's working
         * tree — mutable on the host side, and re-exec'd by
         * `--restart unless-stopped` after a reboot — and `ensureEgressRelay`
         * adopts a running relay without comparing what it forwards. The
         * ledger is therefore the only place where "this run would have run
         * different code, or forwarded somewhere else, than the last one"
         * becomes visible at all. Recording it only on creation would miss
         * exactly the adopted case, which is the one nothing else can see.
         */
        await ledger.append("egress_relay_ready", {
          detail: {
            name: egressRelay.name,
            created: egressRelay.created,
            script_sha256: egressRelay.scriptSha256,
            targets: egressRelay.targets.map(
              (t) => `${t.name}:${t.listenPort}->${t.host}:${t.port}`,
            ),
          },
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

      /**
       * One independent checkout per `worktree`-mode worker (SRD §9.1),
       * created before anything detached exists.
       *
       * A CLONE, not `git worktree add` — `run/worktree.ts`'s header records
       * the three designs that were tested and why the two worktree-based ones
       * were rejected, one of them as a confirmed container-to-host RCE. The
       * short version: a clone's `.git` is a real directory inside the mount,
       * so the container reaches nothing outside `/workspace` and the
       * operator's repository is untouched by anything a worker does.
       *
       * Placed in the same band as materialization below and for the same
       * reason: after the ledger so refusals are recorded, after config load
       * so a bad config costs nothing on disk, and BEFORE `launchDetached`,
       * because everything from there onward survives a thrown `CliError` and
       * has to be reaped while this does not.
       *
       * This is also where hazard NEUTRALIZATION finally belongs (ISC-249).
       * The detect-only scan above deliberately leaves the operator's own
       * checkout alone; the clone is disposable, is the tree the worker
       * actually reads, and — unlike a linked worktree, whose `.git` is a
       * pointer FILE that `repo-hazards.ts` explicitly declines to follow —
       * has a real `.git` directory, so that module's config, attributes and
       * hooks scanners all apply to it completely rather than partially.
       */
      const worktrees: WorkerWorktree[] = [];
      if (loadedConfig !== null && repoRoot !== null) {
        const repo = repoRoot;
        await createWorkerWorktrees({
          loaded: loadedConfig,
          run,
          repo,
          workerIds: workers,
          onCreated: async (created, note) => {
            // Neutralization runs, and the post-neutralization baseline is
            // captured, BEFORE anything is pushed or recorded — not after, as
            // an earlier version of this callback did. Quarantine
            // (`security/repo-hazards.ts`) neutralizes a tracked hazard file
            // by RENAME, which is real, uncommitted change in `git status
            // --porcelain` from the instant it happens; recording `created`
            // (pre-neutralization) as the durable checkout would have made
            // EVERY clone of a repository with a root `AGENTS.md`/`CLAUDE.md`
            // read as dirty from birth, and `down --prune` would refuse every
            // worker on an entirely ordinary repository without `--force`.
            // See `captureWorktreeBaseline`'s own docstring for why a
            // recorded STATUS baseline is the fix rather than a commit or a
            // hand-filtered exclusion list.
            const hazards = await neutralizeRepoHazards(created.path);
            const wt = await captureWorktreeBaseline(created);

            worktrees.push(wt);
            // Re-written per worker, not once at the end. A clone is real
            // state on disk and a failure on worker three leaves workers one
            // and two behind; a record written afterwards records neither, so
            // `down --prune` would have nothing to reap them by.
            runDoc["worktrees"] = worktrees;
            await writeJsonAtomic(run.runJson, runDoc);
            await ledger.append("worktree_created", {
              worker: wt.workerId,
              detail: {
                path: wt.path,
                branch: wt.branch,
                base_sha: wt.baseSha,
                remote: wt.remoteName,
                replaced_stale_remote: note.replacedStaleRemote,
              },
            });
            if (note.replacedStaleRemote && opts.json !== true) {
              process.stderr.write(
                `  replaced a stale '${wt.remoteName}' remote in ${repo} (its checkout was gone)\n`,
              );
            }

            for (const h of hazards) {
              await ledger.append("repo_hazard", {
                worker: wt.workerId,
                detail: { path: h.path, kind: h.kind, neutralized: h.neutralized, detail: h.detail },
              });
            }
            if (hazards.length > 0 && opts.json !== true) {
              const live = hazards.filter((h) => !h.neutralized).length;
              process.stdout.write(
                `  ${wt.workerId}: ${hazards.length} hazard(s) in its checkout, ` +
                  `${hazards.length - live} neutralized${live > 0 ? `, ${live} STILL LIVE` : ""}\n`,
              );
            }
          },
        });
        // Written even when `worktrees` is empty — `[]` is the legitimate
        // final state of a fleet where no worker resolves to `worktree`
        // isolation, and the comment above this block is explicit that only
        // `[]`, never the initial `null`, should read that way to `down
        // --prune`. `createWorkerWorktrees` returns early with nothing
        // created for exactly that fleet shape, so `onCreated` never fires
        // and `runDoc["worktrees"]` would otherwise be stuck at `null` —
        // "creation never completed" — forever, on a run where creation was
        // never supposed to do anything in the first place.
        runDoc["worktrees"] = worktrees;
        await writeJsonAtomic(run.runJson, runDoc);
        if (worktrees.length > 0 && opts.json !== true) {
          for (const wt of worktrees) {
            process.stdout.write(`  ${wt.workerId}: ${wt.path} on ${wt.branch}\n`);
          }
        }
      } else {
        // The no-config Phase 1 path (`up --workers eng-1` against a
        // `PIFLEET_PI_COMMAND` double, no `fleet.yaml` reachable): there is
        // no config to resolve a worker's isolation mode against, so no
        // worktree was ever going to be created — `[]`, not the initial
        // `null`, for the identical reason the branch above states. Without
        // this, `readRunWorktrees` (which now treats a surviving `null` as
        // "creation never finished" rather than "nothing to record") would
        // misdiagnose every legitimate no-config run the same way it now
        // correctly diagnoses a crashed `up`.
        runDoc["worktrees"] = [];
        await writeJsonAtomic(run.runJson, runDoc);
      }

      /**
       * Every host path a worker's container will bind-mount is created HERE,
       * before anything detached exists (SRD §5.5).
       *
       * A `-v` whose source is missing does not fail. Docker creates it — a
       * directory source comes up empty, and a FILE source comes up as an empty
       * DIRECTORY — so an unmaterialized `/skills` is a worker with no skills
       * and an unmaterialized `/policy/cloud-allow` is a verbgate reading a
       * directory. Both read as agent behaviour, not as mount faults.
       *
       * The ordering is the same argument the allowlist gate above makes.
       * After the ledger, so events land in the authoritative-`seq` `cli-up`
       * shard. After config load and `assertModelsAllowed`, so a refusal there
       * costs nothing on disk. Before the daemon and the launch loop, because
       * everything from `launchDetached` onward survives a thrown `CliError`
       * and has to be reaped, while this is pure filesystem work that can
       * refuse with nothing running behind it.
       *
       * Config-gated like the two controls above: the no-config Phase 1 path
       * (`up --workers eng-1` against a `PIFLEET_PI_COMMAND` double) has no
       * mount table to materialize and must keep starting.
       *
       * A failure aborts the WHOLE launch rather than skipping one worker —
       * see `materialize.ts`'s second rule.
       */
      if (loadedConfig !== null) {
        // Appended AS each worker completes, not once over the returned array.
        // Materialization writes real directories and files, and a failure on
        // worker three leaves worker one's and two's on disk — a batch append
        // after the fact records neither, which is the forensic gap on exactly
        // the failure path this is built to make loud.
        /**
         * `useDouble` — the fleet's choice between containers and the double —
         * is read ONCE, at the top of this action, and consumed here and at the
         * image gate. It used to be computed at this line only; the gate needs
         * the same answer several hundred lines earlier, and two independent
         * readings of one environment variable are two things that can disagree
         * after an edit.
         *
         * `PIFLEET_PI_COMMAND` is documented as the path to the Pi DOUBLE, so
         * setting it is an explicit statement of intent — run this instead of
         * the real thing — and an explicit override beats a derived default.
         * That is also what keeps every existing integration and e2e test
         * working unchanged: they all set it, and none of them has an image.
         *
         * Said on stderr rather than assumed, because the failure mode of
         * getting this wrong is quiet in both directions: a stale
         * `PIFLEET_PI_COMMAND` in a shell profile would otherwise silently run
         * doubles for an operator who expected containers, and every artifact
         * would look like a normal run.
         */
        if (useDouble && opts.json !== true) {
          process.stderr.write(
            "pifleet: PIFLEET_PI_COMMAND is set, so workers run as host processes against the " +
              "Pi double and NO containers are started; unset it to launch containers\n",
          );
        }
        await materializeWorkerInputs(loadedConfig, run, workers, async (m) => {
          await ledger.append("worker_inputs_materialized", {
            worker: m.workerId,
            detail: {
              role: m.role,
              outbox: m.outboxDir,
              // The worker's OWN list, which is what `--skill` names; the
              // bundle is per-role and holds the union across the role.
              skill_names: m.skillNames,
              skills: m.skillsDir,
              cloud_allow: m.cloudAllow,
              system_append: m.systemAppendMd,
              kubeconfig: m.kubeconfig,
              kubeconfig_source: m.kubeconfigSource,
            },
          });
        }, { writeLaunchRecord: !useDouble });
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
      /**
       * The precedence expression lives further up, beside `runDoc` — the run
       * record and the `run_created` ledger event both state which backend was
       * requested, and both are written long before this point.
       */
      const resolution = await resolveBackendWithFallback({
        primary: await loadBackend(requestedBackend),
        ledger,
        ...(opts.backendFallback === undefined
          ? {}
          : { fallback: await loadBackend(opts.backendFallback) }),
      });
      const backend = resolution.backend;
      await ledger.append("backend_ready", {
        detail: {
          requested: requestedBackend,
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
          /*
           * `PIFLEET_PI_COMMAND` is forwarded when this process HAS it, and
           * omitted otherwise. A configured run ignores it — the supervisor
           * branches on the launch record, not on this variable — but
           * forwarding it unconditionally as `undefined` would put the literal
           * string "undefined" into the child's environment, which the
           * supervisor's own emptiness check does not catch.
           */
          env: {
            PIFLEET_RUNS_DIR: root,
            ...(process.env["PIFLEET_PI_COMMAND"] !== undefined
              ? { PIFLEET_PI_COMMAND: process.env["PIFLEET_PI_COMMAND"] }
              : {}),
          },
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
        /**
         * `backend` is the backend that was ACTUALLY SELECTED, not the one
         * that was asked for.
         *
         * It used to be `opts.backend` — the raw flag. With
         * `--backend-fallback` in play those are different values, so a run
         * that asked for cmux, found it unavailable and fell back to tmux
         * reported `"cmux"` to its only machine-readable consumer while
         * `presentation.json` (written from `backend.kind` a few hundred lines
         * up) correctly said tmux. Two records of one fact, disagreeing.
         *
         * Removing the commander default would ALSO have turned this field
         * into `undefined` — which `JSON.stringify` drops entirely, so the key
         * would have vanished from the payload rather than gone wrong loudly.
         * Fixing the value and removing the default are the same edit.
         */
        process.stdout.write(
          `${JSON.stringify({ run_id: runId, backend: backend.kind, workers: launched })}\n`,
        );
      } else {
        process.stdout.write(`run ${runId}\n`);
        for (const w of launched) {
          process.stdout.write(`  ${w.id}: supervisor pid ${w.pid} (pgid ${w.pgid}) idle\n`);
        }
      }
    });
}
