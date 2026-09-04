import type { Command } from "commander";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { CliError } from "../index.ts";
import { EXIT, type WorkerLaunch } from "../../contracts.ts";
import { Stopwatch } from "../../rpc/client.ts";
import { newRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { materializeWorkerInputs } from "../../run/materialize.ts";
import { buildWorkerEnv } from "../../run/worker-env.ts";
import {
  readWorkerLaunch,
  readWorkerState,
  runBudgetRecord,
  readPresentation,
  writePresentation,
} from "../../run/state.ts";
import { attachArgv, enterTui, DETACH_KEYS } from "../../attended/mode.ts";
import {
  adoptRefusal,
  adoptRefusalMessage,
  adoptedAttachArgv,
  adoptedSurface,
} from "../../attended/adopt.ts";
// The driver that changes no pane. Imported from the `tui` command rather than
// re-declared, because it is an ASSERTION about a tui worker's pane — that
// entering attended mode must not respawn a pane which is already a person's
// `docker attach` — and two spellings of it could disagree.
import { PANE_ALREADY_ATTENDED } from "./tui.ts";
import { launchPaneMode } from "../../container/interrupt.ts";
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
import {
  WORKER_SCRATCH_DIR,
  cloneSourceMount,
  makeWorkerAccessible,
  resolveCloneSource,
  resolveLaunchRepo,
} from "../../container/mounts.ts";
import { assertBindMountsVisible } from "../../container/mount-preflight.ts";
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
import {
  disclosureFor,
  formatDisclosureBanner,
  type DisclosureRow,
} from "../../security/disclosure.ts";
import { assertModelsSupportToolCalls } from "../../security/model-probe.ts";
import { containerFetch } from "../../security/probe-transport.ts";
import { checkMlxTrainingGuard, describeMatch } from "../../safety/mlx-training-guard.ts";
import {
  egressBridgePlan,
  ensureBridgeRelay,
  formatRelayTarget,
  RelayUpstreamResolutionError,
  workerEgressNetwork,
  type ProviderBridge,
  type RelayStatus,
} from "../../security/relay.ts";
import { detectRepoHazards, neutralizeRepoHazards } from "../../security/repo-hazards.ts";
import { effectiveHarnessPatterns } from "../../harvest/acceptance.ts";
import { captureWorktreeBaseline, createWorkerWorktrees, type WorkerWorktree } from "../../run/worktree.ts";
import {
  DEFAULT_HEARTBEAT_INTERVAL_MS,
  DEFAULT_PROSE_TURNS_BEFORE_FAIL,
  DEFAULT_UI_REQUEST_TIMEOUT_MS,
  effectiveProseTurnsBeforeFail,
} from "../../config/schema.ts";

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
/**
 * Which argv a worker's pane runs (TUI spec item 9).
 *
 * A `tui` worker's pane attaches to Pi's own TTY; every other worker's pane
 * runs the read-only viewer it always has. The `viewer` argv is passed IN
 * rather than built here so that this function cannot change it: the rpc pane
 * has to stay byte for byte what it is today, and the surest way to guarantee
 * that is for the routing code to be incapable of touching it.
 *
 * Exported because the decision is the whole of the risk in this phase. The
 * tui pane has no behaviour to regress — it did not exist — while routing BOTH
 * modes through one new call site is exactly the refactor that quietly sends
 * every worker down the new path. Inline in the 1600-line command body that
 * would only be reachable by a live `up` against a real container; as a pure
 * function both arms are pinned by a unit probe.
 *
 * ## The mode is READ, never sniffed
 *
 * `launchPaneMode` is the resolver the interrupt path already uses: the
 * recorded `launch.pane_mode` field LEADS and the argv marks (`--mode rpc`,
 * `-t`) only veto. Deliberately not a second `pane_mode === "tui"` test
 * written here — `materialize.ts` makes this argument about the launch argv,
 * that two independent computations of one fact are two things that can
 * disagree after an edit, and a pane routed by the loser of that disagreement
 * certifies the wrong control plane.
 *
 * `unknown` — record and marks disagreeing — takes the VIEWER, the read-only
 * arm. A pane showing logs for a worker whose mode is in doubt costs a view;
 * attaching a keyboard to what might be an RPC control plane costs the run.
 *
 * `launch === null` is the `PIFLEET_PI_COMMAND` double. It starts no container
 * but DOES have a live supervisor and control socket, so **a worker with no
 * container is an rpc worker** and takes the viewer — the same reading
 * `planInterrupt(null)` settled on, which previously refused here from a true
 * premise and a wrong conclusion.
 */
export function panePresentationArgv(args: {
  launch: WorkerLaunch | null;
  viewer: readonly string[];
  runId: string;
  workerId: string;
}): readonly string[] {
  return panePresentationIsAttach(args)
    ? attachArgv(args.runId, args.workerId)
    : args.viewer;
}

/**
 * Is this worker's pane a person's `docker attach`, rather than the read-only
 * viewer?
 *
 * Extracted from `panePresentationArgv` above rather than re-tested at the
 * second call site, and that is the entire point of it existing. Two decisions
 * now hang on this one question — which argv the pane runs, and whether the
 * attended record is written at `up` time — and they MUST NOT be able to
 * disagree. A worker whose pane is an attach but whose run reports unattended
 * is the gap this closes; a worker recorded as attended whose pane is the
 * read-only viewer is the same lie pointing the other way.
 *
 * Sharing the predicate makes both impossible by construction instead of by
 * two matching conditionals that a later edit could drift apart. The pane argv
 * and the attendance record are one decision with two consequences.
 *
 * `launch === null` is `rpc`: the `PIFLEET_PI_COMMAND` double has no container
 * and therefore no TTY — the same reading `planInterrupt(null)` settled on.
 */
export function panePresentationIsAttach(args: {
  launch: WorkerLaunch | null;
}): boolean {
  return args.launch !== null && launchPaneMode(args.launch) === "tui";
}

/**
 * Which of `workerIds` this config resolves to `pane_mode: tui`.
 *
 * One resolution, consumed by both Phase 4 guards below (the unattended
 * warning, spec item 12) and by nothing else — `up`'s per-worker record is
 * written from the LAUNCH RECORD via `launchPaneMode`, not from here, because
 * by that point the argv exists and the argv is the stronger witness.
 *
 * `resolveWorker` rather than a walk of `config.workers`: `pane_mode` is
 * assembled across `defaults` -> `roles` -> the worker override (`config/load.ts`
 * `pick`), and re-deriving that merge here is exactly the second copy
 * `assertSecretsResolvable`'s docblock argues against — a guard with its own
 * spelling of "is this worker tui" can drift from the one that renders the
 * argv, and the drift is silent in the direction that matters.
 *
 * IDS THE CONFIG DOES NOT DEFINE are skipped, by the same MEMBERSHIP test and
 * the same `defined` set `assertModelsAllowed` uses. An id that exists only on
 * the command line — the `PIFLEET_PI_COMMAND` double — has no role and so no
 * `pane_mode` to resolve; that worker is `rpc` by construction (it has no
 * container and therefore no TTY), which is the reading `planInterrupt(null)`
 * and `panePresentationArgv` both already settled on.
 */
export function tuiWorkerIds(loaded: LoadedConfig, workerIds: readonly string[]): string[] {
  const defined = new Set(loaded.config.workers.map((w) => w.id));
  const out: string[] = [];
  for (const workerId of workerIds) {
    if (!defined.has(workerId)) continue;
    if (resolveWorker(loaded, workerId).paneMode === "tui") out.push(workerId);
  }
  return out;
}

/**
 * The provider each of `workerIds` resolves to — in launch order, duplicates
 * kept. The input to `egressBridgePlan`, and the reason D7's containment
 * property is a fact about this run rather than about the config file.
 *
 * **`resolveWorker`, not `Object.keys(config.llm.providers)`, and the
 * difference is the whole of ISC-410.** The keys of the map are what an
 * operator DECLARED; this is what workers SELECTED. Building the bridge plan
 * from the declaration would put a network, a relay and a published listen
 * alias behind a provider nothing in the fleet uses — which is precisely what
 * the fleet-wide design did (§6.5.1: declaring a provider published its
 * hostname on the one shared bridge for every worker on it), and precisely what
 * D7 exists to stop.
 *
 * `resolveWorker` for the same reason `tuiWorkerIds` uses it: `provider` is
 * assembled across `defaults` -> `roles` -> the worker override, and a second
 * spelling of that merge here would be a guard that can disagree with the
 * resolver that renders the argv.
 *
 * IDS THE CONFIG DOES NOT DEFINE are skipped, by the same membership test —
 * the `PIFLEET_PI_COMMAND` double has no role, no provider and no container to
 * attach to a network.
 */
/**
 * The `egress_relay_ready` ledger row's `detail`, as a function (ISC-426).
 *
 * ## Why this is not an object literal at the append site any more
 *
 * It was, and the whole of D9's audit half was invisible because of it.
 * Mutation-tested by deleting the resolution fields outright: the FULL suite —
 * 3349 tests across 211 files — stayed green, because the only thing that
 * produces this row is a real `up` against a real daemon, and the one test that
 * reads it belongs to another criterion. A record nothing can reach is a record
 * nothing can check, and §6.7 asks this row to keep *"what did this relay
 * actually dial"* answerable months later.
 *
 * Exported for the same reason `resolvedProviders` above is: the assertion has
 * to be able to reach production's derivation rather than a copy of it. A test
 * that rebuilt this shape would agree with itself and with nothing else.
 *
 * ## The resolution fields are SPREAD, so a relay that resolved nothing is
 * byte-identical to what it always wrote
 *
 * A flat pre-D7 fleet and a non-hosted provider get no key at all rather than a
 * `null` one. `null` would read as *"we resolved and got nothing"*, which is a
 * different and false claim about a provider whose schema refuses a hostname in
 * the first place.
 */
export function egressRelayReadyDetail(
  bridge: ProviderBridge,
  status: RelayStatus,
): Record<string, unknown> {
  return {
    name: status.name,
    // Which provider this relay is FOR, and which network it is on. The name
    // already encodes both, but only for a reader who knows the composition
    // rule — and `report` reads these rows months later, when several relays
    // differ by one suffix.
    provider: bridge.provider,
    network: bridge.network,
    created: status.created,
    script_sha256: status.scriptSha256,
    targets: status.targets.map(formatRelayTarget),
    /*
     * BOTH halves of D9's resolution, or neither (ISC-426).
     *
     * `targets` above already carries the ADDRESS — it must, or the relay would
     * be dialing a name through Docker's embedded DNS (§6.7) — and an address
     * alone does not answer *"what did this relay dial, and on whose
     * authority"*: `egress.allow` authorizes the NAME (ISC-428), so a reader
     * holding only the literal cannot line the two up after the fact. The pair
     * is the record; either half alone is not.
     */
    ...(bridge.upstreamResolution === null
      ? {}
      : {
          relay_upstream_resolved: {
            name: bridge.upstreamResolution.name,
            address: bridge.upstreamResolution.address,
          },
        }),
  };
}

export function resolvedProviders(loaded: LoadedConfig, workerIds: readonly string[]): string[] {
  const defined = new Set(loaded.config.workers.map((w) => w.id));
  const out: string[] = [];
  for (const workerId of workerIds) {
    if (!defined.has(workerId)) continue;
    out.push(resolveWorker(loaded, workerId).provider);
  }
  return out;
}

/**
 * Whether nothing about this `up` invocation says a person is present
 * (TUI spec item 12).
 *
 * ## The question this can and cannot answer
 *
 * `tui` is the mode whose entire value is a person at a keyboard, so "was this
 * started by a person" is the question the warning turns on. Nothing in a run
 * directory can answer it; the only evidence `up` has is the shape of its own
 * invocation, and there are exactly two usable facts:
 *
 *  - **`--json`.** The operator asked for machine-readable output, which names
 *    a machine consumer. A script pipes this to `jq`; a person reading panes
 *    does not.
 *  - **No terminal anywhere on this process.** `isTTY` on all three standard
 *    streams. CI, a cron entry, a detached wrapper and a `nohup` all present as
 *    three pipes; a person at a shell has at least one terminal even when they
 *    redirect the other two (`pifleet up > out.txt` keeps stdin and stderr).
 *
 * EITHER ALONE IS ENOUGH, and that is a deliberate choice to OVERWARN. A
 * spurious warning costs an operator one paragraph on stderr — `pifleet up
 * --json | jq` typed at a real terminal will get one. A missed warning costs a
 * fleet of workers in a mode nobody is driving, discovered at the deadline.
 * The asymmetry is the same one `attended/mode.ts` is built on, pointed the
 * other way: that record must never underclaim attendance, so this must never
 * underclaim its absence.
 *
 * **DOES NOT CLAIM** to know whether a person is still there. It cannot see an
 * operator who starts a fleet from a terminal and walks away, and it cannot see
 * one who arrives ten minutes later with `pifleet attach`. Both are false
 * answers this function will give, and neither is closable from here — which is
 * the reason spec item 12 asks for a WARNING and not a refusal.
 */
export function runIsUnattended(args: {
  json: boolean;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
  stderrIsTty: boolean;
}): boolean {
  if (args.json) return true;
  return !(args.stdinIsTty || args.stdoutIsTty || args.stderrIsTty);
}

/**
 * The warning `up` prints when a `tui` worker is launched into an unattended
 * run (TUI spec item 12) — or `null` when there is nothing to say.
 *
 * ## It names what is GIVEN UP, not that something is
 *
 * "warning: tui worker in an unattended run" is a sentence an operator can only
 * act on by going and reading SRD §3.5. The costs below are that table made
 * concrete, and each one is a thing this build actually does:
 *
 *  - `dispatch --auto` refuses the worker outright with
 *    `pane_mode_tui_is_not_auto_schedulable` (`cli/commands/dispatch.ts`), so an
 *    auto schedule silently routes around it.
 *  - A plain `pifleet dispatch` DOES reach it — the prompt is typed into the
 *    pane — but with `epoch: null` and no ack: `cmux` exiting 0 means bytes
 *    reached a pty, not that Pi read them. Re-dispatching the same task runs it
 *    twice; the `already_completed` replay that makes that a no-op on the rpc
 *    path (ISC-85) does not exist here.
 *  - A blocking `extension_ui_request` waits for a person to answer a dialog.
 *    §3.5 calls that "acceptable only because attended" — unattended it is a
 *    worker stopped until the run's `ui_request_timeout` fires.
 *  - `pifleet abort` is `docker kill --signal=INT`, which through the
 *    entrypoint's trap STOPS the worker (`container/interrupt.ts`, measured).
 *    It is not a turn-interrupt; Pi's turn-interrupt is the ESCAPE keystroke,
 *    which needs a keyboard.
 *  - Completion is transcript-derived and coarser, because the epoch fence
 *    (SRD §7.5) is voided in this mode.
 *  - The pane OWNS the attach. Closing it stops the worker — F15 is false here,
 *    and it is false whether or not anyone is watching.
 *
 * The headline is the last line rather than the first: every cost above is paid
 * for a benefit that only exists when someone is at the keyboard.
 *
 * Pure, and returns the text rather than writing it, for the reason
 * `panePresentationArgv` is pure: the decision is the whole of the risk, and a
 * function that wrote to stderr could only be probed by capturing a stream.
 */
export function unattendedTuiWarning(args: {
  tuiWorkers: readonly string[];
  unattended: boolean;
}): string | null {
  if (!args.unattended) return null;
  if (args.tuiWorkers.length === 0) return null;
  const n = args.tuiWorkers.length;
  return (
    [
      `warning: ${n} worker(s) resolve to pane_mode: tui (${args.tuiWorkers.join(", ")}) and ` +
        `nothing about this invocation says a person is here to drive their panes`,
      `  a tui worker has no RPC control plane, so this run gives up:`,
      `    dispatch --auto  will not schedule it (pane_mode_tui_is_not_auto_schedulable)`,
      `    dispatch         types into the pane with epoch null and no ack; a re-dispatch`,
      `                     runs the task twice (no already_completed replay, ISC-85)`,
      `    ui requests      a blocking dialog waits for a person until ui_request_timeout`,
      `    abort            is docker kill --signal=INT: a STOP of the worker, not a`,
      `                     turn-interrupt (that is the ESCAPE key, and needs a keyboard)`,
      `    completion       is transcript-derived and coarser; the epoch fence is void`,
      `    the pane         OWNS the attach, so closing it stops the worker`,
      `  every one of those is paid for a benefit only a person at the keyboard collects.`,
      `  Take a pane with: pifleet attach --worker ${args.tuiWorkers[0]}`,
      `  or set pane_mode: rpc for workers this run will drive over the control plane.`,
    ].join("\n") + "\n"
  );
}

export function assertModelsAllowed(loaded: LoadedConfig, workerIds: readonly string[]): void {
  const defined = new Set(loaded.config.workers.map((w) => w.id));
  for (const workerId of workerIds) {
    if (!defined.has(workerId)) continue;
    assertModelAllowed(loaded, resolveWorker(loaded, workerId));
  }
}

/**
 * `secrets:` is resolvable for every worker, BEFORE the run directory exists.
 *
 * `buildWorkerEnv` already refuses an unallowlisted name, a reserved one, and
 * one the host environment does not carry, and `materializeWorkerInputs` calls
 * it — so `up` would fail on a bad `secrets:` with or without this gate. What
 * it buys is WHERE: without it the refusal lands after the run directory, the
 * per-worker clones and the remotes in the operator's own repository are on
 * disk, which is the exact complaint the image gate below records at length.
 *
 * IT CALLS `buildWorkerEnv` RATHER THAN RE-DERIVING THE PREDICATE, and that is
 * the whole design of this function. A gate with its own copy of "is this name
 * allowed" can drift from the one that runs at launch, and the drift is
 * invisible in the safe direction — a gate that permits what launch refuses is
 * merely useless, while one that refuses what launch permits blocks a working
 * fleet. There is one decision function; this calls it and throws away the
 * plan. Building an env plan is pure and allocates a small object, so the
 * duplicated work is not worth a second predicate to avoid.
 */
export function assertSecretsResolvable(
  loaded: LoadedConfig,
  workerIds: readonly string[],
  hostEnv: Record<string, string | undefined>,
): void {
  const defined = new Set(loaded.config.workers.map((w) => w.id));
  for (const workerId of workerIds) {
    if (!defined.has(workerId)) continue;
    buildWorkerEnv(loaded, resolveWorker(loaded, workerId), hostEnv);
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

/** A backend kind, plus the input that decided it. */
export interface RequestedBackend {
  kind: "cmux" | "tmux" | "headless";
  /** Named as an operator would say it, because refusals below quote it. */
  source: "--backend" | "backend.kind" | "the built-in default";
}

/**
 * THE ONE PLACE THE BACKEND IS CHOSEN (ISC-271), as a function.
 *
 *     explicit --backend  >  the config's backend.kind  >  DEFAULT_BACKEND
 *
 * The expression is unchanged; what is new is that it now also reports WHICH
 * of the three terms answered, and that it is callable without an `up`.
 *
 * The SOURCE is not decoration. `DEFAULT_BACKEND` is `headless`, so a config
 * that sets `pane_mode: tui` and says nothing about a backend is refused by
 * `assertTuiBackendPossible` below for a reason no line of that config
 * contains. "backend is headless" would send the operator to grep their
 * fleet.yaml for a word that is not in it; "the built-in default" tells them
 * what to actually do.
 *
 * Pure and exported for the reason `panePresentationArgv` is: the precedence IS
 * the criterion, and a test that re-declared it would prove only that its own
 * copy is self-consistent. The integration suite's ISC-271 block still grades
 * the wiring through `run.json`, which is what makes this more than a
 * self-consistent pair.
 */
export function resolveRequestedBackend(args: {
  flag: "cmux" | "tmux" | "headless" | undefined;
  configKind: "cmux" | "tmux" | "headless" | null;
}): RequestedBackend {
  if (args.flag !== undefined) return { kind: args.flag, source: "--backend" };
  if (args.configKind !== null) return { kind: args.configKind, source: "backend.kind" };
  return { kind: DEFAULT_BACKEND, source: "the built-in default" };
}

/**
 * Refuse a `tui` worker on the EFFECTIVE headless backend (TUI spec item 4,
 * second half) — the residual Phase 1 declared and could not close.
 *
 * ## What the schema can see, and what it cannot
 *
 * `config/schema.ts` refuses a document that SAYS `backend.kind: headless`
 * beside a `pane_mode: tui` worker, and that is all it can ever refuse.
 * `backend.kind` is `.optional()` and an absent block means UNSET (ISC-271), so
 * TWO shapes reach a headless backend without the word appearing anywhere the
 * schema is looking:
 *
 *   1. `--backend headless` typed at `up`, which beats any config; and
 *   2. **a config that says nothing at all** — because `DEFAULT_BACKEND` is
 *      `headless`, which is what every run in this repository has been getting.
 *
 * The second is the one worth pausing on. Phase 1's note names only the flag,
 * and the default is the commoner accident by a wide margin: an operator adds
 * `pane_mode: tui` to a working fleet.yaml, changes nothing else, and gets a
 * config the schema passes and a run with no pane to attach to.
 *
 * ## Why a refusal and not a warning
 *
 * `headless` has no pane. `up`'s own `createPane` returns a null surface, so
 * `panePresentationArgv` has nothing to attach `docker attach` to; the
 * container comes up with `-i -t` and Pi renders a TUI onto a terminal nobody
 * holds; `pifleet tui --worker` refuses it ("no pane to hand over") and
 * `pifleet dispatch` refuses it ("a tui worker's prompt has nowhere to go").
 * Every downstream command already says no. Without this the operator learns
 * that one command at a time, after the fleet is up, which is the "quiet
 * failure" shape SRD §5.9 exists to prevent.
 *
 * The refusal is EXIT.USAGE for the same reason the schema's is: nothing is
 * wrong with the host, the combination cannot work.
 */
export function assertTuiBackendPossible(args: {
  tuiWorkers: readonly string[];
  backend: RequestedBackend;
  /**
   * `--attach-here` was passed AND survived its own guard.
   *
   * The exemption is narrow on purpose. This guard's premise was that
   * "headless" means no pane exists; adoption is the case where a pane exists
   * and pifleet did not create it (`attended/adopt.ts`). `assertAttachHere`
   * runs FIRST and has already established there is exactly one tui worker on
   * a real terminal, so by the time this sees `true` the sentence below —
   * "there is nothing to attach" — is simply false.
   *
   * Defaulted `false` so every existing caller and fixture keeps the original
   * refusal without being edited, which is what makes this an added branch
   * rather than a weakened one.
   */
  attachHere?: boolean;
}): void {
  if (args.attachHere === true) return;
  if (args.backend.kind !== "headless") return;
  if (args.tuiWorkers.length === 0) return;
  const ids = args.tuiWorkers.join(", ");
  throw new CliError(
    `refusing to start: ${args.tuiWorkers.length} worker(s) resolve to pane_mode: tui ` +
      `(${ids}), but this run's backend is headless — chosen by ${args.backend.source}.\n` +
      `  A tui worker's pane IS its terminal: up gives its container a TTY and the pane runs ` +
      `docker attach onto Pi. A headless run creates no pane, so there is nothing to attach, ` +
      `nothing to type into, and no way to reach the worker at all — pifleet tui refuses it ` +
      `("no pane to hand over") and pifleet dispatch refuses it ("nowhere to go").\n` +
      `  Pass --backend cmux (or tmux), or set pane_mode: rpc for these workers.\n` +
      `  config/schema.ts refuses this at parse time only when the document SAYS ` +
      `backend.kind: headless; ${args.backend.source} is the surface it cannot see.`,
    EXIT.USAGE,
  );
}

/**
 * Refuse `--attach-here` when this process cannot hand over its terminal.
 *
 * A thin throwing wrapper over `adoptRefusal`, kept here for the reason
 * `assertTuiBackendPossible` is here: the DECISION is pure and lives in
 * `attended/adopt.ts` where it can be reddened clause by clause, and the CLI
 * owns only the exit code. `EXIT.USAGE` for the same reason its neighbour
 * uses it — nothing is wrong with the host, the combination cannot work.
 *
 * Runs BEFORE `assertTuiBackendPossible`, and the order is load-bearing: this
 * one is what licenses that one's exemption, so a run that fails here must
 * never have reached the branch that trusts it.
 */
export function assertAttachHere(args: {
  attachHere: boolean;
  tuiWorkers: readonly string[];
  backend: RequestedBackend;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}): void {
  if (!args.attachHere) return;
  const refusal = adoptRefusal({
    tuiWorkers: args.tuiWorkers,
    backendKind: args.backend.kind,
    backendSource: args.backend.source,
    stdinIsTty: args.stdinIsTty,
    stdoutIsTty: args.stdoutIsTty,
  });
  if (refusal === null) return;
  throw new CliError(`refusing to start: ${adoptRefusalMessage(refusal)}`, EXIT.USAGE);
}

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
    .option(
      "--attach-here",
      "hand THIS terminal to the run's single pane_mode: tui worker (headless backend only)",
    )
    .option(
      "--attach-clear",
      "with --attach-here, clear the screen at handover so only the agent remains",
    )
    .option("--i-know", "proceed despite a detected conflicting workload")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { workers?: string; backend?: string; backendFallback?: string; config?: string; json?: boolean; iKnow?: boolean; attachHere?: boolean; attachClear?: boolean }) => {
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
      /*
       * `sessions` is CREATED owner-only and then widened deliberately, and
       * the ordering is the whole of what changed (ISC-335).
       *
       * What is under here is every worker's entire conversation — each tool
       * call, each result, and on 2026-08-28 the 41-character API token a
       * worker echoed on its second command. It used to be created at the
       * umask default and chmod-ed one line later, so there was a real window
       * in which it existed at a mode nobody chose. `mode` is applied by
       * `mkdir(2)` itself, so the first state this directory is ever in is
       * 0700 and the widen below is a deliberate act on a known starting
       * point rather than a correction of an accident.
       *
       * THE WIDEN IS UNCONDITIONAL, and an earlier draft of this that made it
       * conditional on `useDouble` was WRONG in a way worth recording. Workers
       * run as uid 10001 (`WORKER_UID`), a Linux bind mount passes host
       * ownership through, and a 0700 directory owned by the operator leaves a
       * worker unable to create its own transcript at all — the macOS VM
       * squashes ownership and hides that completely. But the deciding fact is
       * not the platform: `up` renders and materializes a full container mount
       * table on EVERY run, `/sessions` is in it, and
       * `test/integration/up-wiring.test.ts` asserts that every `-v` source
       * exists at the mode the mount needs. Skipping the widen put the
       * directory out of step with a mount table that was still being
       * produced, which is precisely the divergence that guard exists to
       * catch, and it caught it. A mode that disagrees with the mount table is
       * a worse defect than a directory that is wider than one run needed.
       *
       * SO THE TRANSCRIPT FILE IS NOT PROTECTED BY ITS MODE, and this is the
       * honest statement rather than a gap left implicit. It is created by Pi,
       * not by pifleet, so its mode is Pi's umask; and 0600 on it is not
       * merely unimplemented but UNREACHABLE in the current two-uid design,
       * because the host harvester must READ that file while the container uid
       * must WRITE it and the two share no group — any mode that denies other
       * users denies one of the two. `events.jsonl`, which is written by the
       * supervisor and read by nothing in a container, has no such conflict
       * and IS 0600 from its first byte.
       */
      await mkdir(run.sessionsDir, { recursive: true, mode: 0o700 });
      await mkdir(run.workersDir, { recursive: true });
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
       * The dialog answer bound travels with the run for the same reason
       * (SRD §12.3 guard 2 — ISC-111, ISC-112).
       *
       * The supervisor is detached and is handed a run directory and a worker
       * id, never a config path, so `timers.ui_request_timeout` reaches the
       * only process that can act on it through `run.json` or not at all. It
       * did not reach it at all until this line: the key parsed, documented
       * itself in `fleet.example.yaml`, and changed nothing — the same dead
       * shape `max_concurrent` was in before the budget reached dispatch, and
       * the reason ISC-111's "within 5s" had no timer behind it.
       */
      let uiRequestTimeoutMs = DEFAULT_UI_REQUEST_TIMEOUT_MS;
      /**
       * The zero-tool-call bound travels with the run for the third time and
       * the same reason (SRD §5.9 detector 2 / F39 — ISC-108).
       *
       * The value written below is the EFFECTIVE one —
       * `run.prose_turns_before_fail` folded together with
       * `llm.require_native_tool_calls` by `effectiveProseTurnsBeforeFail` — so
       * §5.9's "`require_native_tool_calls: false` disables both" becomes one
       * number rather than a conjunction the supervisor would have to re-derive
       * from a config it cannot read. Until this line the runtime half of that
       * sentence had nothing behind it in either direction: there was no
       * detector to disable, and no route by which the gate could have
       * disabled one.
       *
       * The no-config fallback is the schema default (3), NOT zero. A run
       * started without a `fleet.yaml` is exactly the run nobody probed, so it
       * is the run most in need of the runtime detector — defaulting it off
       * would be a guard that vanishes precisely when the other guard is
       * absent too.
       */
      let proseTurnsBeforeFail = DEFAULT_PROSE_TURNS_BEFORE_FAIL;
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
      /**
       * The launch directory when it overrode `run.repo`, else `null`.
       *
       * Declared beside `repoRoot` and for the same reason: it is set inside
       * the config-load block and read after it, by the side-mount decision.
       */
      let launchRepo: string | null = null;
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
        uiRequestTimeoutMs = loadedConfig.config.run.timers.ui_request_timeout * 1000;
        proseTurnsBeforeFail = effectiveProseTurnsBeforeFail(loadedConfig.config);
        harnessPatterns = effectiveHarnessPatterns(loadedConfig.config.harness);
        egressNetwork = loadedConfig.config.docker.network;

        /**
         * THE LAUNCH DIRECTORY IS THE REPOSITORY.
         *
         * A console launched from `~/repos/rally-cli` is a console whose
         * workers work on rally-cli — `/workspace` is a worktree of it, the
         * harvest reads its diff, and `bun test`/`pytest` in the obvious place
         * is the right thing to run.
         *
         * Before this, `run.repo` won unconditionally, so those workers got
         * cmux-fleet at `/workspace` and rally-cli only as a read-only
         * side-mount they had to be instructed to find. Measured twice: they
         * did not find it, and ran cmux-fleet's own suite instead. See
         * `resolveLaunchRepo` for the evidence and why documenting the
         * side-mount could not repair it.
         *
         * `null` — the launch directory IS the fleet repo, or is not a git
         * checkout — leaves the configured value untouched, so the ordinary
         * `cd ~/repos/cmux-fleet && ./scripts/development` is unchanged.
         *
         * Assigned BEFORE `repoRoot` and before the hazard scan, disclosure and
         * ADC checks, all of which read `run.repo`: they must grade the
         * repository that will actually be mounted, not the one in the file.
         */
        launchRepo = await resolveLaunchRepo(loadedConfig, process.cwd());
        if (launchRepo !== null) {
          loadedConfig.config.run.repo = launchRepo;
          process.stderr.write(
            `pifleet: launch directory ${launchRepo} is the workspace repository ` +
              `for this run (fleet.yaml's run.repo is not used)\n`,
          );
        }
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
         * Beside it, and before the first clone, for the reason
         * `assertSecretsResolvable`'s own docstring gives: the refusal exists
         * to happen while nothing is on disk yet.
         */
        assertSecretsResolvable(loadedConfig, workers, process.env);

        /**
         * §7.3's DISCLOSURE — the list of workers whose context will leave the
         * machine, printed BEFORE anything is created (ISC-414, ISC-415).
         *
         * ## Why this is a print and not a refusal
         *
         * D10 ruled against the draft. A worker resolving to a `hosted: true`
         * provider while holding `cloud_access: true` or a non-empty `secrets:`
         * **stands up** — not gated, not warned-and-continued, permitted. §7.2
         * is explicit that *"the fleet does not decide which of the operator's
         * data is theirs to send. It makes sure they cannot send it without
         * knowing."* So the thing that makes the reversal safe is that this
         * line prints, and §7.4 records it in terms: *"the banner is the entire
         * control."*
         *
         * ## Why HERE
         *
         * §7.3 says *"before creating anything"*, and the distance between that
         * and the alternative is the difference between a disclosure and a
         * receipt: a banner printed after the clones, the networks and the
         * relay tells an operator what has already happened. This sits with the
         * config-vs-config gates above — after them deliberately, since a run
         * that is about to be refused sends nothing and a banner for it would
         * be a false alarm — and before the image gate, before
         * `ensureEgressNetwork`, before the first clone, before the daemon and
         * before any supervisor.
         *
         * ## STDOUT, except under `--json`, and it is never suppressed
         *
         * ISC-414's probe asserts the banner on stdout, and that is where it
         * goes for a person. `--json` is the one deviation and it is forced:
         * every machine consumer of this command does `JSON.parse(stdout)` —
         * the `--json` payload is a single object written at the end — so a
         * banner on stdout would not disclose anything to a script, it would
         * crash it. Redirected to stderr, which no consumer parses and every
         * terminal and log shows. **Redirected, never dropped**: a `--json`
         * bring-up that printed nothing would be the silent standup ISC-417
         * forbids, reached through the flag a machine consumer is most likely
         * to use, and both halves of that are asserted.
         *
         * The rows come from `disclosureFor` and from nowhere else. The launch
         * record's copy calls the same function on the same worker — ISC-417
         * compares the two sets and fails on a difference in either direction,
         * which is a coin flip the moment two places decide who is on the list.
         */
        {
          const disclosures: DisclosureRow[] = [];
          const definedWorkers = new Set(loadedConfig.config.workers.map((w) => w.id));
          for (const workerId of workers) {
            // The `PIFLEET_PI_COMMAND` double names ids the config never
            // defined, exactly as `assertModelsAllowed` and `resolvedProviders`
            // skip them: a worker with no config has no provider to be hosted.
            if (!definedWorkers.has(workerId)) continue;
            const row = disclosureFor(loadedConfig, resolveWorker(loadedConfig, workerId));
            if (row !== null) disclosures.push(row);
          }
          const banner = formatDisclosureBanner(disclosures);
          if (banner !== null) {
            if (opts.json === true) process.stderr.write(banner);
            else process.stdout.write(banner);
          }
        }

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
       * ## It MOVED here from beside `runDoc`, and the move is the point
       *
       * The expression is unchanged and `runDoc` still reads it, so nothing
       * about ISC-271 is affected. What the position buys is the pane-mode
       * guards below, which need the EFFECTIVE backend and are worth nothing
       * if they arrive late: from this line down `up` creates the egress
       * network, adopts or starts the relay CONTAINER, and asks the model
       * server one probe per worker. A config that can never work should not
       * pay for any of that first. This is the earliest line at which the
       * answer exists — `loadedConfig` is final one block above.
       *
       * NOT FIXED HERE, and named so it is filed rather than forgotten:
       * `workspace`, `split` and `focus_on_dispatch` in the same
       * `BackendSchema` block still have no config reader anywhere. Wiring
       * `kind` alone leaves three documented options that change nothing.
       */
      const configBackend: "cmux" | "tmux" | "headless" | null = loadedConfig?.config.backend.kind ?? null;
      /**
       * The precedence moved into `resolveRequestedBackend` so that the guards
       * below can quote WHICH input answered. `opts.backend` was validated
       * against `isBackendKind` at the top of this action, which is what makes
       * the narrowing here a restatement rather than an assumption.
       */
      const backendChoice = resolveRequestedBackend({
        flag: opts.backend as "cmux" | "tmux" | "headless" | undefined,
        configKind: configBackend,
      });
      const requestedBackend = backendChoice.kind;

      /**
       * THE PHASE 4 PANE-MODE GUARDS (TUI spec items 12 and 4).
       *
       * WHAT HAS ALREADY HAPPENED AT THIS POINT, stated rather than left for a
       * reader to discover: the run directory exists and the image gate has
       * run. Nothing is DETACHED — no daemon, no supervisor, no pane, no
       * relay — so a refusal from here leaves the same "nothing launched"
       * state `assertModelsAllowed` and `assertImagesReady` leave, which is
       * the property `up-wiring.test.ts` asserts by reading an empty
       * `workersDir` and an empty ledger.
       */
      const tuiWorkers = loadedConfig === null ? [] : tuiWorkerIds(loadedConfig, workers);
      /**
       * Spec item 4's second half, and it runs BEFORE the warning because a
       * refusal supersedes advice: a run that cannot start does not also need
       * telling what it would have given up. Phase 1 declared this residual
       * openly — the schema can only see a document that SAYS headless — and
       * this is the EFFECTIVE-backend check it asked for.
       */
      /**
       * Adoption is checked FIRST because it is what licenses the exemption in
       * the guard below. `--attach-here` on a run that cannot support it must
       * fail on its own terms — naming the terminal, the worker count or the
       * backend — rather than falling through to a message about headless
       * panes that would not describe what the operator did wrong.
       */
      const attachHere = opts.attachHere === true;
      assertAttachHere({
        attachHere,
        tuiWorkers,
        backend: backendChoice,
        // `isTTY` is `true | undefined` on a Node/Bun stream, never `false`.
        stdinIsTty: process.stdin.isTTY === true,
        stdoutIsTty: process.stdout.isTTY === true,
      });
      assertTuiBackendPossible({ tuiWorkers, backend: backendChoice, attachHere });
      /**
       * Spec item 12 — a WARNING, never a refusal. An operator may know
       * exactly what they are doing: launching a tui fleet from a script and
       * then walking over to the panes is a legitimate thing to do, and
       * `runIsUnattended` cannot tell that from CI. Said on stderr NOW, for
       * the reason the MLX override warning above gives — the ledger does not
       * exist for another ~100 lines, and a warning that arrives after the
       * decision is not a warning — and appended to the ledger below so the
       * record survives the terminal scrollback.
       */
      const tuiWarning = unattendedTuiWarning({
        tuiWorkers,
        unattended: runIsUnattended({
          json: opts.json === true,
          // `isTTY` is `true | undefined` on a Node/Bun stream, never `false`.
          stdinIsTty: process.stdin.isTTY === true,
          stdoutIsTty: process.stdout.isTTY === true,
          stderrIsTty: process.stderr.isTTY === true,
        }),
      });
      // Stderr and not stdout, so `--json`'s one-object stream stays one
      // object — and `--json` is itself one of the two things that trip this.
      if (tuiWarning !== null) process.stderr.write(tuiWarning);

      /**
       * THE BRIDGE PLAN — one egress network and one relay per provider IN USE
       * (D7, SRD §6.5.2).
       *
       * Built from the providers this run's workers RESOLVED TO, so a provider
       * declared in `llm.providers` that nothing selected reaches no line
       * below: no `ensureEgressNetwork`, no `ensureEgressRelay`, no published
       * alias, no ledger row. Under the fleet-wide design a declared provider
       * was a route opened for every worker on the shared bridge whether or not
       * anything used it (§6.5.1); here the declaration is inert until a worker
       * names it.
       *
       * A flat `fleet.yaml` with no `providers` map yields exactly ONE bridge,
       * on `docker.network` verbatim — see `egressBridgePlan` for why that case
       * is not composed. Everything below therefore does for a pre-D7 fleet
       * precisely what the single-network code it replaced did.
       */
      let egressBridges: readonly ProviderBridge[] = [];
      if (egressNetwork !== null && loadedConfig !== null) {
        try {
          /*
           * `await`, because building the plan now performs ONE host-side
           * effect: a `hosted: true` provider's hostname `relay_upstream` is
           * resolved here and the LITERAL is stamped into the target (D9,
           * §6.7, ISC-426). It is deliberately inside `egressBridgePlan` rather
           * than a step this line has to remember afterwards — the plan's
           * target is the single derivation of what a relay dials, and a
           * "resolve the plan" call a caller could omit is the same shape as
           * the optional argument `ensureBridgeRelay` exists to remove.
           */
          egressBridges = await egressBridgePlan(
            loadedConfig.config,
            egressNetwork,
            resolvedProviders(loadedConfig, workers),
          );
        } catch (err) {
          /*
           * TWO exit codes, because there are now two kinds of failure here.
           *
           * A composed name Docker will not take, or a worker resolving to an
           * undeclared provider, is a config error: `USAGE`, edit `fleet.yaml`.
           * A resolver that did not answer is not — the config may be exactly
           * right and the machine's DNS merely down — so it reports
           * `BACKEND_UNAVAILABLE` and does not send the operator to edit a
           * correct file. Neither has created anything yet, which is why the
           * plan is built before the first daemon call rather than lazily
           * inside the loop.
           */
          const code =
            err instanceof RelayUpstreamResolutionError ? EXIT.BACKEND_UNAVAILABLE : EXIT.USAGE;
          throw new CliError(err instanceof Error ? err.message : String(err), code);
        }
      }

      /**
       * Each of those networks must exist, and must be INTERNAL, before any
       * container is attached to it.
       *
       * `render.ts` already puts every worker on a fleet network, so the
       * attachment was never the gap — creation was. An absent network makes
       * `docker run` fail, which is loud and fine. A network of that name that
       * someone created WITHOUT `--internal` is the dangerous case: every
       * worker gets unrestricted egress while the fleet reports deny-all, and
       * nothing anywhere would say so. `ensureEgressNetwork` refuses to adopt
       * one rather than quietly using it (SRD §5.6, §12).
       *
       * THE EMPTY-PLAN CASE still runs that check, on the base network. A
       * configured run whose named workers are all undefined in `fleet.yaml`
       * has no provider to resolve and so no bridge — but `docker.network` may
       * still exist on this host, and skipping the adopt-refusal because this
       * particular run happened to launch nothing would drop a security check
       * on a network the next run will use. No relay is created for it: a
       * network nothing is attached to needs no forward.
       */
      const egressNetworks: Array<{ network: string; internal: boolean | null; gateway: string | null }> = [];
      const plannedNetworks =
        egressBridges.length > 0
          ? egressBridges.map((b) => b.network)
          : egressNetwork !== null
            ? [egressNetwork]
            : [];
      for (const network of plannedNetworks) {
        try {
          /**
           * `ensureEgressNetwork` now guarantees BOTH halves of the posture:
           * the daemon reports the network internal, AND its bridge gateway is
           * contained by a host firewall rule (ISC-51). `--internal` alone is
           * not containment — Docker implements it in FORWARD, and the gateway
           * is on-link inside the bridge subnet, so gateway-destined traffic
           * is delivered through INPUT and never evaluated. Either half
           * missing throws here rather than starting a fleet that reports
           * deny-all while workers reach the host's sshd.
           *
           * Per network and not once: two providers are two bridges with two
           * gateways, and a fleet that verified containment on one of them
           * while the other's gateway was open would report a posture it does
           * not have.
           */
          const net = await ensureEgressNetwork(network);
          egressNetworks.push({ network, internal: net.internal, gateway: net.gateway });
        } catch (err) {
          // `err.message` rather than `String(err)`: these errors already
          // begin "egress: " / "relay: ", and `String(err)` prepends
          // "Error: " so the operator reads "Error: relay: …".
          throw new CliError(err instanceof Error ? err.message : String(err), EXIT.BACKEND_UNAVAILABLE);
        }
      }

      /**
       * …and the relay that reopens exactly one destination through each of
       * them.
       *
       * The internal bridge denies the fleet's own model server along with
       * everything else, so without this every worker starts healthy and
       * accomplishes nothing — §5.9's quiet-failure shape exactly. The relay
       * is a durable, shared resource: `ensureEgressRelay` adopts a running
       * one unchanged, and `down` never tears it down, for the same reason it
       * never removes the egress network.
       *
       * **The relay is built once per bridge, from that bridge's PROJECTED
       * view AND that bridge's own target** (§6.5.4). The per-provider-ness
       * lives in `relayViewForProvider` and in `egressBridgePlan`, so the
       * sentence in this file's sibling header — *"the single container that
       * re-opens exactly one destination"* — survives D7 rather than being
       * retired by it. Each of these relays still carries exactly one target;
       * there are simply as many relays as there are providers a worker asked
       * for.
       *
       * An earlier revision of this comment said `ensureEgressRelay` was
       * "called unchanged", and that was true and was the bug: called with the
       * view alone it re-derived its target through `omlxRelayTarget` and
       * labelled every provider's relay `omlx`. `ensureBridgeRelay` takes the
       * target from the bridge so there is no argument for a caller to omit.
       *
       * Each forwards ITS OWN provider ONLY. The Google endpoints in
       * `egress.google_hosts` remain policy-level allow rules with no live
       * relay path (ISC-253); a `cloud_access` worker on any of these bridges
       * still cannot reach them.
       */
      const egressRelays: Array<{ bridge: ProviderBridge; status: RelayStatus }> = [];
      for (const bridge of egressBridges) {
        try {
          egressRelays.push({ bridge, status: await ensureBridgeRelay(bridge) });
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
      /**
       * ## The gate is A CONFIG THAT LOADED, and nothing else (ISC-430)
       *
       * This read `if (loadedConfig !== null && egressNetwork !== null)`, and
       * the second conjunct could not be false while the first was true:
       * `egressNetwork` is assigned unconditionally from
       * `loadedConfig.config.docker.network`, and `schema.ts` DEFAULTS that key
       * to `pifleet-egress`. So the condition STATED a dependency on Docker
       * being configured that the probe does not have, and a reader who
       * believed it would be wrong about where the money goes — the same class
       * of harm as ISC-264's two quietly-disagreeing constants.
       *
       * Behaviour is unchanged, deliberately: ISC-423 establishes that a
       * headless fleet SHOULD probe, because its workers dial the provider
       * whether or not a pane is drawn, and a per-backend opt-out from a
       * mandatory gate is the shape ISC-420 already refused. What changed is
       * that the condition now says the true precondition — a config parsed, so
       * there are providers and models to probe — and the network is DERIVED
       * from that same config at the point of use rather than carried here in a
       * nullable that has to be re-checked. One check, one source; the two can
       * no longer be made to disagree, which is what "delete the conjunct"
       * would not have achieved (the body needs a `string`, and deleting it
       * would not have typechecked).
       */
      if (loadedConfig !== null) {
        /*
         * ONE TRANSPORT PER PROVIDER, on that provider's own bridge (ISC-418).
         *
         * This was `containerFetch({ network: egressNetwork })` — one transport
         * on `docker.network` — and under D7 that is the BASE bridge, which a
         * providers-map fleet never creates. The probe container exited
         * "network not found" and `up` could not stand such a fleet up at all
         * with `require_native_tool_calls: true`; the workaround was to turn the
         * gate off, which is the one thing §5.9 will not have.
         *
         * `workerEgressNetwork` rather than a third spelling of the composition:
         * it already decides which bridge `egressBridgePlan` CREATES and which
         * one `render.ts` ATTACHES a worker to, and a probe judging a third
         * network would certify a path no worker takes.
         */
        const probeConfig = loadedConfig;
        /*
         * The base network, taken from the config rather than from the
         * nullable above — `schema.ts` defaults this key, so it is a `string`
         * here by the schema's own type and needs no second null check. That
         * is the whole of ISC-430's fix: the dependency the gate has is on the
         * CONFIG, and the network is something the config supplies.
         */
        const probeNetwork = probeConfig.config.docker.network;
        await assertModelsSupportToolCalls(loadedConfig, workers, (provider) =>
          containerFetch({
            network: workerEgressNetwork(probeConfig.config, probeNetwork, provider),
          }),
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
      const runDoc: Record<string, unknown> = {
        schema: "pifleet.run/v1",
        run_id: runId,
        created_at: new Date().toISOString(),
        backend: requestedBackend,
        workers,
        heartbeat_interval_ms: heartbeatIntervalMs,
        /**
         * The bound the supervisor answers a blocking `extension_ui_request`
         * within (SRD §12.3 guard 2 — ISC-111, ISC-112). Read back by
         * `readRunUiRequestTimeoutMs`, which is the ONLY consumer this key has
         * ever had — see the declaration above for why it had none.
         */
        ui_request_timeout_ms: uiRequestTimeoutMs,
        /**
         * Consecutive zero-tool-call turns before a task is failed
         * `no_tool_calls` (SRD §5.9 detector 2 / F39 — ISC-108), already folded
         * with `llm.require_native_tool_calls`; `0` is the detector off. Read
         * back by `readRunProseTurnsBeforeFail`, its only consumer, which is
         * the supervisor's only route to this policy.
         */
        prose_turns_before_fail: proseTurnsBeforeFail,
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
      /**
       * The durable half of the unattended-tui warning, on the same terms as
       * the MLX one above: stderr is where the operator reads it, the ledger is
       * where `report` reads it months later. A run that launched a mode whose
       * guarantees depend on a person, with no evidence of a person, should not
       * have that fact live only in a scrollback buffer.
       *
       * The row carries the WORKERS and not the prose. The sentence is this
       * build's wording and will be reworded; the list of workers is the fact.
       */
      if (tuiWarning !== null) {
        await ledger.append("tui_unattended", { detail: { workers: tuiWorkers } });
      }
      /**
       * ONE ROW PER NETWORK, not one row naming a list.
       *
       * A flat fleet still writes exactly the row it always wrote, with the
       * same three fields. A two-provider fleet writes two, and that is the
       * shape a reader of the ledger needs: `internal` and `gateway_blocked`
       * are facts about ONE bridge, and folding two bridges into one row would
       * force a reader to guess which network an unblocked gateway belonged to.
       */
      for (const net of egressNetworks) {
        await ledger.append("egress_network_ready", {
          detail: { network: net.network, internal: net.internal, gateway_blocked: net.gateway },
        });
      }
      for (const { bridge, status: egressRelay } of egressRelays) {
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
        /*
         * THE DETAIL COMES FROM ONE FUNCTION, not from a literal here.
         *
         * `script_sha256` and `targets` are recorded on EVERY run, adopted or
         * created, and that is the point rather than an accident. The relay
         * executes a bind-mounted file from the operator's working tree —
         * mutable on the host side, and re-exec'd by `--restart unless-stopped`
         * after a reboot — and `ensureEgressRelay` adopts a running relay
         * without comparing what it forwards. The ledger is therefore the only
         * place where "this run would have run different code, or forwarded
         * somewhere else, than the last one" becomes visible at all. Recording
         * it only on creation would miss exactly the adopted case, which is the
         * one nothing else can see.
         */
        await ledger.append("egress_relay_ready", {
          detail: egressRelayReadyDetail(bridge, egressRelay),
        });
        /**
         * A SEPARATE row, not a field on the one above, and deliberately so
         * (ISC-265). Replacing a drifted relay changes where every worker on
         * this egress network — including another fleet's — sends its model
         * traffic, which is a different class of event from "the relay is up".
         * Its own event type is greppable and cannot be lost in a detail blob.
         *
         * `replaced` is null when the previous targets were unreadable, and
         * the row still fires: the swap happened either way, and the honest
         * record of an unreadable predecessor is that it was unreadable.
         */
        if (egressRelay.created && egressRelay.replaced !== null) {
          await ledger.append("relay_targets_replaced", {
            detail: {
              name: egressRelay.name,
              was: egressRelay.replaced.map(formatRelayTarget),
              now: egressRelay.targets.map(formatRelayTarget),
            },
          });
        }
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
       * `<repo>/.worktrees/<run-id>/<worker>` as `/workspace`, so the tree a worker
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
      /*
         * The working directory workers may clone FROM, decided ONCE here.
         *
         * `up`'s cwd is the directory the operator started the console in — the
         * console scripts pass it to cmux as `--cwd`, so each agent pane's `up`
         * inherits it. When that is a git working directory OTHER than
         * `run.repo`, it is exposed read-only and a worker can clone it into its
         * writable scratch.
         *
         * Not `run.repo`: that already arrives as the worker's own `/workspace`
         * worktree, and mounting it a second time under another name would give
         * the same repository two identities in one container — one harvested,
         * one not.
         *
         * Resolved in `up` rather than in `render` because `render` is the dry
         * preview and must describe the run that WILL happen, not the directory
         * the preview was typed in (ISC-188).
         */
        /*
         * `launchRepo` has already made this directory `/workspace`, and the
         * docblock above says why mounting it a second time under another name
         * is wrong: one repository, two identities in one container, only one
         * of them harvested. So the side-mount survives only for the case it
         * was actually for — a clone source that is NOT the workspace.
         */
        const cloneSource =
          launchRepo !== null ? null : await resolveCloneSource(loadedConfig, process.cwd());
        if (cloneSource !== null) {
          process.stderr.write(
            `pifleet: workers may clone ${cloneSource} from ` +
              `${cloneSourceMount(cloneSource)} (read-only) into ${WORKER_SCRATCH_DIR}\n`,
          );
        }

        const materialized = await materializeWorkerInputs(loadedConfig, run, workers, async (m) => {
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
        }, { writeLaunchRecord: !useDouble, cloneSource });

        /**
         * EVERY BIND-MOUNT SOURCE THIS RUN WILL USE IS ONE THE RUNTIME CAN SEE
         * (ISC-292).
         *
         * On a VM-backed runtime — Docker Desktop, colima, Rancher — `-v
         * <src>:<dst>` against a path outside the daemon's shared set DOES NOT
         * FAIL. The VM has no such path, so the runtime creates an empty
         * directory there and mounts that, and `docker run` exits 0. The
         * container reads an empty `/workspace`, finds no `/skills`, writes an
         * `/outbox` nobody harvests, and names the cause in no log. It cost a
         * false diagnosis once already, and it was LOUD that time only because
         * a worker happened to read a mounted briefing as a file and got
         * EISDIR; the directory mounts degrade to silent.
         *
         * ## Why here
         *
         * `doctor` has probed the two operator-settable roots since Phase F,
         * and that is a report an operator has to remember to ask for. The
         * criterion says such a mount is "refused OR reported"; enforcement
         * that lives only in `doctor` has the second half while `up` launches
         * anyway, and the launch is where the cost lands.
         *
         * The position in this function is the same argument the allowlist gate
         * and the materialize block above both make. AFTER materialize, because
         * the sources have to exist before their visibility is a question that
         * can be asked — `renderWorker` runs before anything is created, which
         * is exactly why ISC-127's guard sits there and this one cannot.
         * BEFORE `launchDetached`, because everything from that line onward
         * survives a thrown `CliError` and has to be reaped, while a refusal
         * here has nothing running behind it.
         *
         * ## Why the FINISHED argv
         *
         * The same reason ISC-44 and ISC-127 are enforced on it: no literal in
         * the mount table can be audited to rule this out, because the
         * offending path arrives from `run.repo`, `PIFLEET_RUNS_DIR` and
         * `PIFLEET_SCRATCH_DIR`. Taking the argv from `materialize`'s own
         * record rather than re-rendering means the bytes checked are the bytes
         * the supervisor will spawn.
         *
         * It covers strictly more than `doctor` can: `run.repo` and the
         * kubeconfig are on this argv and are not roots `doctor` knows to name
         * — both were recorded as residuals of the Phase F close.
         *
         * ## Skipped on the double, which is not a hole
         *
         * `PIFLEET_PI_COMMAND` starts NO container (see `writeLaunchRecord`
         * above), so there is no mount to be about and no image to probe in.
         * `launchArgv` is null on exactly that path, so the filter below states
         * it rather than re-deriving it.
         */
        const containerLaunches = materialized.filter(
          (m): m is typeof m & { launchArgv: readonly string[]; image: string } =>
            m.launchArgv !== null && m.image !== null,
        );
        if (containerLaunches.length > 0) {
          await assertBindMountsVisible(
            containerLaunches.map((m) => m.launchArgv),
            // The worker image, which `assertImagesReady` proved present far
            // above — not a probe-specific one. A preflight that pulled its own
            // image would be slow on a cold machine and would fail outright on
            // an offline one, and this image is already local by definition.
            containerLaunches[0]!.image,
            realExec,
          );
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
        /*
         * The surface the OPERATOR handed over, when there is one.
         *
         * Only meaningful for the adopted worker: `adoptedSurface` reads the
         * environment of THIS process, which is the terminal `up` was typed
         * in, and that terminal is exactly one worker's pane. Applying it to
         * any other worker in the run would name a surface that is not theirs.
         *
         * `null` for every other case, and that stays a first-class answer:
         * an adopted Terminal.app, ssh session or tmux pane announces no cmux
         * surface, and the staged route degrades to printing the trigger
         * rather than sending it. See `adoptedSurface`.
         */
        const adopted = attachHere && tuiWorkers.includes(workerId);
        const handedOver = adopted ? adoptedSurface(process.env) : null;
        await writePresentation(wp, {
          schema: "pifleet.presentation/v1",
          worker: workerId,
          backend: backend.kind,
          workspace_ref: handedOver?.workspace ?? workspace.id,
          surface_ref: handedOver?.surface ?? pane.id,
          window_ref: null,
          /*
           * WHO owns `surface_ref`, which `backend` above cannot say for an
           * adopted terminal: the run's backend is `headless` and the surface
           * is cmux's. `dispatch` reads this rather than re-deriving it, so
           * the two questions stay separable. See `surface_backend`.
           */
          surface_backend: handedOver?.backend ?? (pane.id === null ? null : backend.kind === "headless" ? null : backend.kind),
          /*
           * No attach child yet, and this is the honest value rather than a
           * placeholder: this write happens BEFORE the spawn, so the pid does
           * not exist. The attach site fills it in and clears it again on
           * detach; see `PresentationSchema.attach_process`.
           */
          attach_process: null,
          /*
           * The terminal that ran `up` is this worker's pane.
           *
           * `tuiWorkers.includes(workerId)` and not the bare flag:
           * `assertAttachHere` has already established there is exactly ONE
           * tui worker when `attachHere` is true, so this marks that worker
           * and no other. An rpc worker in the same run keeps a record that
           * says what it is — a headless run with no pane — because that is
           * still true of it.
           *
           * `surface_ref` USED TO STAY NULL here, on the reasoning that there
           * was no id a later process could send bytes to. There is: a cmux
           * pane announces itself in the environment, and this process is
           * running in it. That was recorded as SRD-TUI-DISPATCH D2 and
           * recommended against; the owner reversed it on 2026-09-02, and the
           * shape that came back is narrower than the one D2 argued against —
           * the brief travels through the read-only file plane and only a
           * short, shell-inert trigger is typed.
           */
          adopted_terminal: adopted,
        });
        const { pid, pgid, started } = await processLauncher.launchDetached({
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
        /*
         * THE LAUNCHER'S RECORD, not a read this command performs (ISC-191,
         * ISC-272). This line used to be `started: (await
         * processStartTime(pid)) ?? ""` — a `ps` against a pid whose child
         * handle this scope does not hold, so nothing here could show the
         * number still named the supervisor rather than whatever the kernel
         * reissued it to. `registry.ts` called this capture site "weaker than
         * the other two" and expected the cost to be the `""` sentinel; the
         * actual cost is a stranger's `(pid, started)` recorded as this run's,
         * which every later guard then confirms. See `launchDetached`.
         */
        identities.set(workerId, { pid, started });
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
             * A `tui` worker's pane attaches to Pi's own TTY; every other
             * worker's pane runs the viewer below, unchanged. The decision
             * lives in `panePresentationArgv` — see its docblock for why the
             * mode is read off the launch record rather than sniffed off the
             * argv, and why an unreadable mode takes the read-only arm.
             *
             * The branch is HERE and not inside `attachViewer` because the
             * backends are argv-generic by design: cmux and tmux both take
             * "run this argv in that pane", and neither should learn what a
             * pane mode is.
             */
            const launch = await readWorkerLaunch(wp);
            /**
             * `env PIFLEET_RUNS_DIR=…` because the pane does NOT inherit this
             * process's environment. Panes are children of a long-lived
             * cmux/tmux server that was started before this run existed, so a
             * viewer relying on the ambient variable would resolve the
             * default `~/.pifleet/runs` and quietly tail the wrong fleet —
             * or nothing at all. `--run` is passed for the same reason:
             * "the most recent run" is a different answer in a stale server.
             */
            const viewer = [
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
            ];
            await backend.attachViewer(
              pane,
              [...panePresentationArgv({ launch, viewer, runId, workerId })],
            );

            /**
             * A `tui` worker is ATTENDED FROM THE MOMENT ITS PANE EXISTS
             * (TUI spec item 4 — the residual gap Phase 3 found and stated).
             *
             * ## The gap
             *
             * `pifleet tui --worker <id>` writes the attended record. That is
             * the right moment for an `rpc` worker, where entering attended
             * mode is a deliberate act: the pane is a read-only viewer until a
             * person asks for it, and the command IS the asking.
             *
             * A `tui` worker has no such moment. Its pane runs `docker attach`
             * onto Pi's own terminal from the instant `up` creates it — the
             * line directly above this one — so the keyboard is already wired
             * to the agent. Waiting for the command meant that between `up`
             * and an operator remembering to run it, a run somebody was
             * actively typing into reported as UNATTENDED.
             *
             * That is the one direction `attended/mode.ts` is built to make
             * impossible. Read its module docblock: both orderings there are
             * chosen so the record can OVERCLAIM attendance and never
             * underclaim it, because a run a person touched must never be able
             * to present as untouched. The gap inverted exactly that, and it
             * did so silently — `report` would have said "unattended" about a
             * pane with hands on it.
             *
             * ## Why `enterTui` and not a direct write
             *
             * `enterTui` is the only sanctioned writer of that record, and
             * routing through it is what keeps this from becoming a second
             * spelling of the attended schema that drifts from the first. It
             * writes the record BEFORE touching the pane, so the ordering
             * guarantee holds here too.
             *
             * `PANE_ALREADY_ATTENDED` is the driver Phase 3 built for the same
             * reason it is needed here: `enterTui`'s default pane action is
             * `interactiveArgv`, `docker exec -it … bash`, which run against a
             * tui worker would REPLACE the person's window onto Pi with a
             * shell. The pane this function just attached is already the
             * intended one; there is nothing to change.
             *
             * ## Failure is non-fatal, deliberately
             *
             * Inside the same `try` as the pane attach, and reported through
             * the same `viewer_failed` ledger entry. `up.ts` already holds that
             * a missing view must never take down a working run, and a missing
             * RECORD is strictly less serious than a missing pane. The cost of
             * the failure is a report that understates attendance — the very
             * thing this closes — so it is logged rather than swallowed.
             */
            if (panePresentationIsAttach({ launch })) {
              await enterTui({
                run,
                workerId,
                backend: PANE_ALREADY_ATTENDED,
                pane,
                /*
                 * `"tui"` is not a guess: the predicate on the line above is
                 * true exactly when `launchPaneMode(launch) === "tui"`, so
                 * inside this block the mode is established rather than
                 * assumed.
                 *
                 * IT MUST BE PASSED, and omitting it is a defect this merge
                 * actually made. `enterTui` defaults to `"rpc"` — correctly,
                 * because every caller written before Phase 4 means that — so
                 * a record written without this argument names the ATTENDED
                 * voided table and not the MODE's. Closing the attendance gap
                 * with the wrong table would report a run as attended while
                 * dropping every row only this mode voids: no epoch, so a
                 * re-dispatch runs the task twice (ISC-85); `cmux` exiting 0
                 * proves only that bytes reached a pty (ISC-86); the session
                 * file was found by suffix match rather than recorded
                 * (ISC-95); `abort` stops the worker rather than interrupting
                 * a turn (ISC-81).
                 */
                paneMode: "tui",
              });
            }
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

      /**
       * HAND THIS TERMINAL TO THE WORKER — the last thing `up` does, and it
       * blocks until the operator detaches.
       *
       * ## Why here and not earlier
       *
       * After the idle wait, which is what lets the attach be a bare
       * `docker attach` rather than the polling wrapper `attachArgv` needs: a
       * backend pane is created BEFORE its container exists and would race the
       * launch, whereas by this line every worker has been observed idle, so
       * the container is running and answering.
       *
       * It is also after the summary print, deliberately. The operator sees
       * the run id and the supervisor pids BEFORE their terminal is taken
       * over — if the attach then fails, or Pi's first frame is a mess, the
       * information they need to go look at the run is already on screen and
       * above the scrollback the TUI is about to paint over.
       *
       * ## The record is written before the terminal is taken
       *
       * `enterTui` first, for the ordering reason `attended/mode.ts` states
       * and `up`'s pane path already follows: the record may OVERCLAIM
       * attendance and must never underclaim it. A crash between these two
       * lines leaves a run marked attended that nobody is looking at, which is
       * the harmless direction; the reverse would let a run somebody is typing
       * into report as untouched.
       *
       * `PANE_ALREADY_ATTENDED` because `enterTui`'s default pane action is
       * `docker exec -it … bash`, which here would open a shell instead of
       * showing Pi. There is no pane to change: this process IS it.
       */
      if (attachHere) {
        const workerId = tuiWorkers[0]!;
        const wp = workerPaths(run, workerId);
        try {
          await enterTui({
            run,
            workerId,
            backend: PANE_ALREADY_ATTENDED,
            /*
             * `id: null` is the honest value and it is what makes
             * `PANE_ALREADY_ATTENDED` safe: there is no backend-native pane to
             * name, because the pane is this process's own terminal. A driver
             * that tried to act on it would have nothing to act on.
             */
            pane: { backend: "headless", id: null },
            paneMode: "tui",
          });
        } catch (err) {
          /*
           * Non-fatal, exactly as the pane path's record write is: a missing
           * record costs an understated report, and refusing to attach over
           * it would deny the operator the thing they asked for to protect a
           * file. Said on stderr rather than swallowed.
           */
          process.stderr.write(
            `pifleet: could not record ${workerId} as attended ` +
              `(${err instanceof Error ? err.message : String(err)}); attaching anyway\n`,
          );
        }
        const argv = adoptedAttachArgv(runId, workerId);
        process.stdout.write(
          `\nattaching this terminal to ${workerId} — detach with ${DETACH_KEYS} ` +
            `(the worker keeps running; ${wp.dir} holds its record)\n`,
        );
        /*
         * `--attach-clear` wipes the screen in the instant between that notice
         * and the handover, so what the operator ends up looking at is Pi and
         * nothing else.
         *
         * OPT-IN, not the default. At a command line every line above is worth
         * having — which image was verified, which secrets were granted by
         * name, where the record lives, and the detach keys. In a standing
         * console pane it is a banner scrolled past once and then carried
         * above the agent for the life of the pane. The flag lets the two
         * cases differ without either losing what it needs.
         *
         * Erase display, erase SCROLLBACK (3J — without it the banner is still
         * one scroll away), then home the cursor.
         */
        if (opts.attachClear === true) process.stdout.write("\u001b[2J\u001b[3J\u001b[H");
        const child = Bun.spawn(argv, { stdin: "inherit", stdout: "inherit", stderr: "inherit" });
        /**
         * RECORD THE ATTACH CHILD'S IDENTITY, which this site used to discard.
         *
         * ## What the absence cost
         *
         * "Is this terminal still the worker's?" had no answer. The pid was in
         * scope right here and thrown away, so nothing downstream could tell an
         * operator sitting at the pane from one who detached an hour ago — and
         * a task staged for a worker whose reader has gone is a task nobody can
         * trigger, reported as accepted. That is the `<none>` shape: a
         * mechanism running over an input nobody is reading.
         *
         * ## Why this is a RECORD and not a read off a live pid
         *
         * `supervisor/launch.ts` states the rule and the failure at length, and
         * it applies here unchanged: a start time read off a bare pid names
         * whoever holds the number, every downstream guard compares the record
         * against the OS, and none of them can catch a record that was WRITTEN
         * from the OS in the first place. What makes this different is the
         * HANDLE. POSIX retains a child's pid until its parent reaps it, so
         * while `exitCode` and `signalCode` are both still null the kernel
         * cannot have reissued `child.pid`, and the read therefore describes
         * the process this line spawned.
         *
         * The check runs AFTER the read, and the order is load-bearing for the
         * reason that file gives: "not reaped now" implies "not reaped at any
         * earlier instant", so a check that passes afterwards vouches for a
         * read taken before it. The reverse order vouches for nothing.
         *
         * ## Non-fatal, in the direction that costs a refusal rather than a lie
         *
         * A failed capture leaves `attach_process: null`, and staging refuses
         * on null. The operator loses the ability to stage — recoverable, and
         * they are told — where the alternative is a guard that passes against
         * a record nothing measured.
         *
         * ## A SECOND write, because the pid cannot exist before the spawn
         *
         * The presentation record is written before the attach so it can never
         * UNDERclaim attendance. The pid is knowable only after. Merging the
         * two would mean spawning before recording, which reverses that
         * property for the sake of one file write.
         */
        try {
          const started = await processStartTime(child.pid).catch(() => null);
          const stillOurs = child.exitCode === null && child.signalCode === null;
          const current = await readPresentation(wp);
          if (current !== null && started !== null && stillOurs) {
            await writePresentation(wp, {
              ...current,
              attach_process: { pid: child.pid, started },
            });
          }
        } catch (err) {
          process.stderr.write(
            `pifleet: could not record the attach process for ${workerId} ` +
              `(${err instanceof Error ? err.message : String(err)}); ` +
              `dispatch will refuse to stage work for it\n`,
          );
        }
        const code = await child.exited;
        /**
         * AND CLEAR IT, because the terminal has stopped being the worker's.
         *
         * Without this the record outlives the reader and the guard inverts:
         * an operator who detaches and walks away leaves a presentation file
         * claiming a live terminal, and the first thing that claim does is
         * satisfy the check that exists to catch exactly this. A stale `true`
         * is worse than no guard, because it is a guard reporting success.
         *
         * Same non-fatal posture, and the failure lands on the safe side by
         * accident of which direction is safe here: an uncleared record
         * over-claims, which is why the write is attempted rather than skipped,
         * and why the operator is told when it could not be made.
         */
        try {
          const current = await readPresentation(wp);
          if (current !== null && current.attach_process !== null) {
            await writePresentation(wp, { ...current, attach_process: null });
          }
        } catch (err) {
          process.stderr.write(
            `pifleet: could not clear the attach process record for ${workerId} ` +
              `(${err instanceof Error ? err.message : String(err)}); ` +
              `it still names a terminal that has detached\n`,
          );
        }
        /*
         * Detaching is a SUCCESS, and docker's exit code cannot tell it from a
         * failure — `--detach-keys` returns 0, and so does a container that
         * exited while attached. The message says which state the worker is in
         * rather than guessing from the code, because those two need different
         * things from the operator next.
         */
        process.stdout.write(
          `\ndetached from ${workerId} (docker attach exit ${code}). ` +
            `The worker is unchanged: pifleet status --run ${runId} to see it, ` +
            `pifleet up --attach-here to come back.\n`,
        );
      }
    });
}
