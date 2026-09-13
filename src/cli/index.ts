#!/usr/bin/env bun
/**
 * `pifleet` entry point.
 *
 * Commands live one-per-file under `src/cli/commands/` and are registered here.
 * Each module exports `register(program)`; the entry point owns argument parsing,
 * the exit-code ladder, and nothing else, so two commands never share a file.
 */

import { Command } from "commander";
import { EXIT, type ExitCode, isExitCoded } from "../contracts.ts";
import type { RunPaths } from "../run/paths.ts";
import type { SweepDispatch, SweepDispatchOutcome } from "../run/triage-envelope.ts";
import type { TriageProductionEffects } from "./commands/triage.ts";

/**
 * Thrown by a command to exit with a specific ladder code and a clean message.
 *
 * The field is `exitCode`, not `code`, so that `CliError` satisfies the
 * structural `ExitCoded` protocol in contracts.ts. It previously did not, and
 * the ladder worked only because the `instanceof` branch below runs first —
 * meaning the structural path the protocol exists to provide was exercised by
 * nothing, and any module-identity split (a duplicated import, a bundling
 * boundary) would have demoted every CLI error to exit 1 plus a stack trace.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.USAGE,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** A commander-thrown error: has a dotted `commander.*` code and was printed already. */
function isCommanderError(e: unknown): e is { code: string; exitCode: number } {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { code?: unknown }).code === "string" &&
    (e as { code: string }).code.startsWith("commander.")
  );
}

/**
 * Classify a thrown value into a ladder code.
 *
 * Exported because this expression IS the entry point's policy, and a test
 * that re-declared it would prove only that its own copy is self-consistent
 * (the same reason `requestedEpochFrom` is exported from `commands/dispatch.ts`).
 *
 * Order matters: a `CommanderError` carries `exitCode: 1`, which satisfies the
 * structural `ExitCoded` protocol and is not a ladder code at all, so commander
 * is classified first.
 */
export function exitCodeForError(err: unknown): ExitCode {
  // `--help` and `--version` arrive here as CommanderErrors after commander has
  // already printed; they are successes, not failures. Everything else
  // commander diagnoses is a usage error. Detected structurally so the
  // commander import stays an implementation detail of this file.
  if (isCommanderError(err)) {
    return err.code === "commander.helpDisplayed" ||
      err.code === "commander.help" ||
      err.code === "commander.version"
      ? EXIT.SUCCESS
      : EXIT.USAGE;
  }
  // One branch: CliError satisfies ExitCoded structurally, so the protocol is
  // the only path and is therefore actually exercised.
  if (isExitCoded(err)) return err.exitCode;
  // Undiagnosed: a bug in pifleet, not a mistake by its caller. Reporting it as
  // EXIT.USAGE collapsed the two into one integer (ISC-216).
  return EXIT.INTERNAL;
}

// ---------------------------------------------------------------------------
// SRD-TRIAGE-CONSOLE §13 task 6.1b — the triage console's privileged effects
// ---------------------------------------------------------------------------

/**
 * The modules the triage effects are built out of, loaded LAZILY and ONCE.
 *
 * ## Why dynamic imports rather than four `import` statements at the top
 *
 * Two reasons, and the first is a correctness one. `cli/commands/dispatch.ts`
 * imports {@link CliError} from THIS file, so a static import of it here is a
 * module cycle whose evaluation order decides whether `CliError` is initialised
 * when the other module's body runs. `src/run/relay.ts` met exactly this and
 * solved it exactly this way (`loadEffectModules`, `:3067`); this is that
 * pattern, not a new one.
 *
 * The second is the entry point's standing property: `pifleet --help` must not
 * load the fleet's control plane. Every command module below is already loaded
 * under one `Promise.all` because registration is cheap; the dispatch path's
 * transitive closure is 145 modules (measured in
 * `test/unit/triage-readonly.test.ts`) and none of them has any business being
 * evaluated because somebody typed `pifleet status`.
 *
 * ## `up` and `down` are here too, and they are the ONE pair that is not lazy
 *
 * §13 task 6.5b's recycle needs both verbs, and `main()`'s registration loop
 * already imports both eagerly — so the laziness argument above buys nothing for
 * these two and the entries are here for the OTHER reason: one loader means one
 * place a reader checks to see everything the triage effects are built out of.
 * They are named here rather than imported statically because the module cycle
 * argument is the same one — `commands/up.ts` and `commands/down.ts` both import
 * {@link CliError} from this file.
 */
let triageEffectModules: Promise<{
  config: typeof import("../config/load.ts");
  relay: typeof import("../run/relay.ts");
  actor: typeof import("../run/triage-actor.ts");
  config_triage: typeof import("../run/triage-config.ts");
  notify: typeof import("../run/triage-notify.ts");
  verdict: typeof import("../run/triage-verdict.ts");
  up: typeof import("./commands/up.ts");
  down: typeof import("./commands/down.ts");
  /* §6.3 step 5 routes each observer to its OWN run — see the dispatch below. */
  triage_cmd: typeof import("./commands/triage.ts");
  paths: typeof import("../run/paths.ts");
  /* §6.6's freshness for pane seats — see the reset after `awaitSettled`. */
  dispatch_cmd: typeof import("./commands/dispatch.ts");
  state: typeof import("../run/state.ts");
  backends: typeof import("../backends/registry.ts");
}> | null = null;

function loadTriageEffectModules(): NonNullable<typeof triageEffectModules> {
  triageEffectModules ??= (async () => ({
    config: await import("../config/load.ts"),
    relay: await import("../run/relay.ts"),
    actor: await import("../run/triage-actor.ts"),
    config_triage: await import("../run/triage-config.ts"),
    notify: await import("../run/triage-notify.ts"),
    verdict: await import("../run/triage-verdict.ts"),
    up: await import("./commands/up.ts"),
    down: await import("./commands/down.ts"),
    triage_cmd: await import("./commands/triage.ts"),
    paths: await import("../run/paths.ts"),
    dispatch_cmd: await import("./commands/dispatch.ts"),
    state: await import("../run/state.ts"),
    backends: await import("../backends/registry.ts"),
  }))();
  return triageEffectModules;
}

/**
 * **§6.3 step 5's per-observer dispatch, and it is the reason task 6.1b exists.**
 *
 * `sendTaskEnvelope` is THE dispatch path and it takes a fleet-ledger writer.
 * Both are banned from `src/run/triage-*` and from `src/cli/commands/triage.ts`
 * by name in `test/unit/triage-readonly.test.ts` — a dynamic `await import`
 * included, because the ban is a substring check over comment-stripped source.
 * **That is the guard working.** §12 grants this console one permitted exception
 * and the exception it grants is `run/dispatch-request.ts`, the request BUILDER;
 * the privileged EFFECT belongs at the composition root, which is here. The
 * one-entry list (ISC-826) is untouched, which is the point.
 *
 * ## `consoleTransport` rather than a second call to `sendTaskEnvelope`
 *
 * `productionRelayEffects.sendTask` already binds the dispatch path to a
 * `LedgerWriter` and derives a content-addressed attempt id so a re-issue
 * REPLAYS instead of running the work twice; `consoleTransport` already wraps it
 * in the three refusals a resolved `accepted: false` needs — a supervisor
 * refusal, a `via: "pane"` delivery that would TYPE a container's brief into a
 * surface, and a stage whose trigger was never sent. Rebuilding any of that here
 * would be a second, untested copy of decisions the review console already pays
 * for. This console's seats are `rpc` by §2.3's anti-criterion, so the preflight
 * that refuses a typed plane is a backstop rather than a live path.
 *
 * ## The settle wait is the caller's bound, not `RELAY_SETTLE_DEADLINE_MS`
 *
 * {@link SweepDispatch} *"returns when the task has SETTLED, not when it was
 * accepted"* — `collate` reads the document the task it dispatched wrote and
 * §6.3 gives `SweepDriver` no member between the two steps. The relay's own
 * 30-minute default is sized for a review; this console ticks every five minutes
 * by default, so waiting half an hour on one child would wedge the actor for six
 * cadences. §7.8's `sweep_deadline_s` (`cadence_s − reserve_s`) is the right
 * bound and the CONSOLE computes it — see `TriageProductionEffects.dispatchFor`.
 *
 * ## What is a value here and what is a throw
 *
 * A `RelayDispatchError` becomes `{kind: "refused"}` — a VALUE — because §6.5's
 * *"refused whole"* is a partition outcome an operator acts on. Everything else
 * propagates: a settle timeout in particular is NOT a refusal, because the task
 * was accepted and may still be running, and reporting it as refused would let
 * `collate` be skipped for a sweep that later produced a document.
 * `budget_exhausted` is not produced here at all — §6.10's ceiling is a decision
 * the console makes from its own read (`refuseOnExhaustedBudget`), one layer up.
 */
function productionSweepDispatchFor(
  run: RunPaths,
  opts: { readonly settleDeadlineMs: number },
): SweepDispatch {
  return async ({ taskId, worker, title, brief }): Promise<SweepDispatchOutcome> => {
    const m = await loadTriageEffectModules();
    const transport = m.relay.consoleTransport(
      m.actor.TRIAGE_COLLATOR,
      m.relay.productionRelayEffects,
      { deadlineMs: opts.settleDeadlineMs },
    );
    /*
     * **Each seat is its own run, and the dispatch must go to the SEAT's run.**
     *
     * `run` here is the COLLATOR's, because that is what every other member of
     * `SweepDriver` is pinned to (§6.4: two values that must agree about a run id
     * is "a new failure mode with no observable"). That argument is right for the
     * run TREE — the inbox to count sweeps in, the outbox to join from — and wrong
     * for the control socket, because D4's own note says a console is FOUR runs and
     * `resolveSeatRuns` exists precisely to say which.
     *
     * Dispatching an observer through the collator's run looks for that observer's
     * socket inside `tri-1`'s run directory and fails `worker <id> is unreachable:
     * SocketRequestError` — which reads as a dead worker and is not one. It is the
     * fleet's own documented trap ("that error means WRONG RUN, not dead worker"),
     * and it cost this console every sweep of its first live run: the fan-out was
     * composed correctly, written correctly, and posted to the wrong door.
     *
     * The review console's relay has always done this right — it routes each child
     * to `p.run` from a worker→run map and refuses `run_unresolved` rather than
     * guessing. This is that rule, applied to the console that was missing it.
     */
    const seatRuns = await m.triage_cmd.resolveSeatRuns(undefined, process.env);
    const seatRunId = seatRuns[worker];
    const target =
      worker === m.actor.TRIAGE_COLLATOR || seatRunId === undefined
        ? run
        : m.paths.runPaths(seatRunId, m.paths.runsRoot(process.env));
    try {
      await transport.dispatch(target, { worker, taskId, title, brief });
    } catch (err) {
      if (err instanceof m.relay.RelayDispatchError) {
        return { kind: "refused", reason: err.message };
      }
      throw err;
    }
    await transport.awaitSettled(target, { worker, taskId });
    /*
     * THE WORK IS DONE — clear the seat's session so the next task starts empty.
     *
     * A `pane_mode: tui` worker keeps its session across dispatches, and this
     * console dispatches to the same four seats every cadence forever, so without
     * this the collator accumulates every sweep of the day into one transcript
     * and answers from what it already holds (`fresh-dispatch.ts`'s measured
     * case). §6.6's recycle is the designed remedy and cannot serve these seats:
     * it is a headless `up`, which cannot recreate a pane.
     *
     * AFTER settle, never before the trigger. Before would fight three things at
     * once — see `resetPaneSession` — and gains nothing: a session cleared after
     * task N is empty for task N+1 either way. Only the instant differs, and this
     * is the instant with no contract on it and no turn to interrupt.
     *
     * Best-effort and never awaited for correctness: the task has settled and its
     * result is durable, so a failed reset costs freshness on the next sweep and
     * nothing else. `resetPaneSession` reports rather than throws for that reason,
     * and an rpc seat with no surface reports `no addressable surface` here, which
     * is the ordinary case rather than a fault.
     */
    const presentation = await m.state.readPresentation(m.paths.workerPaths(target, worker));
    const reset =
      presentation === null
        ? { reset: false, reason: `no presentation record for ${worker}` }
        : await m.dispatch_cmd.resetPaneSession(worker, presentation, m.backends.loadBackend);
    /*
     * LOGGED ON BOTH ARMS, deliberately. The first version logged only the
     * failure, which made "the reset fired" and "the reset never ran" produce
     * byte-identical output — an absence of evidence read as evidence, which is
     * the exact shape of the defects this console keeps producing. §7.7's log is
     * the only place anything about an unattended actor can be read afterwards.
     */
    console.error(
      reset.reset
        ? `triage: session reset SENT to ${worker} — its next task starts on an empty session`
        : `triage: session reset skipped for ${worker}: ${reset.reason ?? "no reason given"}`,
    );
    return { kind: "accepted" };
  };
}

// ---------------------------------------------------------------------------
// SRD-TRIAGE-CONSOLE §13 task 6.5b — §6.6 layer 4's recycle, at the same root
// ---------------------------------------------------------------------------

/**
 * Run one shipped `pifleet` verb IN THIS PROCESS, on a program of its own.
 *
 * ## Why the shipped command and not a lower-level call
 *
 * There is no programmatic `up()` or `down()` in this repository — both verbs
 * are ~700-line commander actions, and every refusal that makes them safe lives
 * inside those actions: `up`'s MLX-training guard, its model allowlist, its
 * secret resolution and its one-tui-worker check; `down`'s pinned-identity
 * anchoring, which is the thing that stops a stale pid being signalled. A
 * recycle that reached past them would be a second, untested copy of the fleet's
 * whole safety posture, owned by the composition root, exercised six times a day
 * with nobody watching. So the effect IS the command.
 *
 * ## In-process rather than a subprocess, and what that buys
 *
 * `scripts/triage` spawns `bun run src/cli/index.ts down --run <id>` because a
 * shell script has no other way to call one. This is in-process, and what that
 * buys is the failure shape: a failure arrives as a THROW, which is exactly what
 * {@link TriageConsolePorts.upSeat}'s contract asks for —
 * `runTriageActor` logs a throwing seat as `recycle_failed`, leaves it unpinned
 * and lets the next boundary finish the job. Translating an exit integer back
 * into a throw would be a second copy of the §10 ladder, in the one place that
 * has no test that could catch it drifting.
 *
 * {@link buildProgram} is what makes this safe to call from a long-lived actor:
 * it sets `exitOverride()`, which commander copies onto every subcommand, so a
 * usage error inside a recycle cannot call `process.exit` on the console's own
 * clock.
 */
async function runFleetVerb(args: readonly string[]): Promise<void> {
  const m = await loadTriageEffectModules();
  const program = buildProgram();
  m.up.register(program);
  m.down.register(program);
  await program.parseAsync([...args], { from: "user" });
}

/**
 * **`--keep-panes`, and it is the difference between a recycle and an outage.**
 *
 * Without it `down` calls `backend.destroy(ref, { keepPanes: false })` for every
 * distinct `workspace_ref` the run's workers recorded (`commands/down.ts:807-825`)
 * — and all four triage seats are panes of ONE cmux workspace, because
 * `scripts/triage` creates the workspace and each pane then runs
 * `pifleet up --workers <one worker>` inside it (§6.1's correction,
 * `operations-plan.ts:310` — *"Each pane creates its own run"*). So an unattended
 * per-seat `down` without this flag would destroy the operator's whole triage
 * workspace — all four panes — to recycle one seat, 24 times a day.
 *
 * The actor is not in the presentation business and cannot recreate a pane
 * anyway (cmux is confined to `src/backends/cmux/` by ISC-137, and this console
 * may not reach a backend at all). Keeping the pane leaves a dead view an
 * operator can see and `scripts/triage` can re-plan; destroying it would
 * dismantle the console monotonically over a day with nothing able to rebuild it.
 *
 * `--json` so the one line this writes to the actor's stdout is a document
 * rather than prose.
 */
async function productionDownRun(runId: string): Promise<void> {
  await runFleetVerb(["down", "--run", runId, "--keep-panes", "--json"]);
}

/**
 * §6.6 layer 4's other half: the seat comes back in a NEW run.
 *
 * `--workers <one seat>` and no `--attach-here`, which is the whole reason this
 * console can be recycled by a process with no terminal: *"`up --attach-here` is
 * what demands a TTY on both streams (`src/attended/adopt.ts:96-114`), and an
 * `rpc` worker is not attached."* (§6.6). One seat per `up` is also what makes
 * the result the four-run shape §6.1's correction measured, rather than a
 * five-seat run nothing else in this console expects.
 *
 * **The run id is not returned, deliberately.** D12 makes the run tree the
 * authority and `TriageConsolePorts.seatRuns` is how it is read; a value returned
 * here would be a second source for the same fact, and the two would be spelled
 * in different places the first time an `up` half-succeeded.
 */
async function productionUpSeat(seat: string): Promise<void> {
  await runFleetVerb(["up", "--workers", seat, "--json"]);
}

/**
 * Everything `pifleet triage` cannot build for itself, assembled from ONE load
 * of the fleet config.
 *
 * `loaded.dir` and not the cwd, on `config/load.ts`'s standing rule — *"a config
 * that renders differently depending on where the command was typed is not a
 * config"* — and it is read here rather than in the console so that the two
 * tracked triage files, the kubeconfig the fence checks and the model a
 * saturation announcement names all come from one reading of one file.
 *
 * The probe dials `hostReachableBaseUrl` and NOT `llm.base_url`: this runs on the
 * HOST, in the actor's process, and `base_url` is what a WORKER dials — on the
 * shipped default it names the relay's bridge alias, which the host cannot
 * resolve at all (ISC-291), so a probe that dialled it would report the endpoint
 * down on a healthy machine and turn every saturation candidate into an
 * `endpoint_down`.
 *
 * The provider and model are `tri-1`'s own resolved pair rather than
 * `llm.provider`/`llm.model`, because §6.7 rule 3's subject is *"the model every
 * seat resolves to"* and a `role:` or per-worker `model:` override is exactly the
 * thing the flat keys do not see.
 */
export async function productionTriageEffects(): Promise<TriageProductionEffects> {
  const m = await loadTriageEffectModules();
  const loaded = await m.config.loadConfig();
  const seat = m.config.resolveWorker(loaded, m.actor.TRIAGE_COLLATOR);
  const dial = m.config.providerHostDialView(loaded.config, seat.provider) ?? loaded.config;
  const apiKey = process.env[m.config.providerApiKeyEnv(loaded.config, seat.provider)] ?? "";

  return {
    dispatchFor: productionSweepDispatchFor,
    /**
     * THE BRIDGE, and the reason it is a pass-through and nothing else.
     *
     * SRD-WORKER-DISPATCH-EXTENSION §7.4: publishing a reply and declaring it at
     * `/policy/replies` are ONE act. That act lives in
     * `productionRelayEffects.publishReplies`, which both consoles reach — the
     * review console through `fanOut`, the triage console through this lambda.
     * Anything done to `replies` on the way through would give the triage
     * console its own version of a set-equality property the review console gets
     * for free, so the array is forwarded untouched.
     */
    publishRepliesFor: (run) => async (taskId, replies) => {
      const mods = await loadTriageEffectModules();
      const transport = mods.relay.consoleTransport(
        mods.actor.TRIAGE_COLLATOR,
        mods.relay.productionRelayEffects,
        { deadlineMs: 0 },
      );
      await transport.publishReplies(run, taskId, replies);
    },
    isCollatorLive: async (run) =>
      await m.relay.productionRunSources.isLiveWorker(run, m.actor.TRIAGE_COLLATOR),
    downRun: productionDownRun,
    upSeat: productionUpSeat,
    triageFiles: m.config_triage.triagePaths(loaded.dir),
    kubeconfigPath:
      loaded.config.cloud.kubeconfig === null
        ? null
        : m.config.expandPath(loaded.config.cloud.kubeconfig, loaded.dir),
    endpoint: { provider: seat.provider, model: seat.model },
    probe: m.verdict.inferenceSaturationProbe(
      dial,
      apiKey,
      seat.model,
      fetch,
      m.config.providerProbeTimeoutMs(loaded.config, seat.provider),
    ),
    transport: m.notify.DEFAULT_NOTIFY_TRANSPORT,
    env: process.env,
  };
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("pifleet")
    .description("Orchestrate a fleet of containerized Pi coding agents")
    .version("0.1.0")
    .showHelpAfterError()
    // Without this commander calls process.exit(1) itself, so the most common
    // error in the whole CLI — a typo'd flag or an unknown subcommand — never
    // reached the ladder and exited 1, a code the SRD §10 ladder does not
    // define. exitOverride routes it through main()'s catch instead.
    .exitOverride()
    .enablePositionalOptions();
  return program;
}

async function main(argv: string[]): Promise<number> {
  const program = buildProgram();

  // Registration order is the order commands appear in `--help`.
  const modules = await Promise.all([
    import("./commands/doctor.ts"),
    import("./commands/image.ts"),
    import("./commands/config.ts"),
    import("./commands/render.ts"),
    import("./commands/up.ts"),
    import("./commands/daemon.ts"),
    import("./commands/status.ts"),
    import("./commands/monitor.ts"),
    import("./commands/worktrees.ts"),
    // Beside `worktrees` because it is the consumer that matters: `pm-guard
    // tester-fresh` answers "is THIS clone current" from the same per-worker
    // checkout `worktrees` lists, and an operator who has just read a stale
    // base sha out of that table wants the refusal next to it.
    import("./commands/pm-guard.ts"),
    import("./commands/dispatch.ts"),
    // Beside `dispatch` because it is the same verb with a different asker: the
    // operator dispatches, and `relay` is what turns a COLLATOR's request into
    // dispatches host-side (SRD-REVIEW-CONSOLE §6.5). An operator reading
    // `--help` to find out how a review console causes work needs the two
    // adjacent, because the answer is that one of them is the other's caller.
    import("./commands/relay.ts"),
    import("./commands/steer.ts"),
    // Beside `abort` because the two are the pair an operator confuses, and
    // `--help` listing them adjacently is where the distinction is cheapest to
    // read: `unstage` releases a staged epoch and leaves the worker running,
    // `abort` on a tui worker sends SIGINT and stops it. See `unstage.ts`.
    import("./commands/unstage.ts"),
    import("./commands/abort.ts"),
    import("./commands/wait.ts"),
    import("./commands/artifacts.ts"),
    import("./commands/transcript.ts"),
    import("./commands/harvest.ts"),
    import("./commands/report.ts"),
    import("./commands/attach.ts"),
    import("./commands/tui.ts"),
    import("./commands/logs.ts"),
    import("./commands/exec.ts"),
    import("./commands/shell.ts"),
    import("./commands/down.ts"),
  ]);
  for (const m of modules) m.register(program);

  /**
   * SRD-TRIAGE-CONSOLE §13 tasks 6.2 and 6.1b — **the one command the uniform
   * loop above cannot register, and the reason is the point.**
   *
   * Task 6.2: registered here and not only in `test/unit/cli.test.ts`'s set. A
   * command module that exists, is tested, appears in `Docs/SRD.md` §10 and is
   * absent from this file is a command an operator cannot run, and every one of
   * those four surfaces reports it as present. Task 6.2's own *Touches* line
   * omitted `src/cli/index.ts`, which is how it was nearly shipped that way, and
   * `test/unit/cli.test.ts` now reads this file as TEXT to stop it happening
   * again (ISC-830).
   *
   * Task 6.1b: `register`'s second parameter is REQUIRED, so this command cannot
   * be registered without a deps factory and `m.register(program)` above would
   * not compile for it. That is deliberate. The triage console needs one
   * capability §12's read-only block forbids it to build — the per-observer
   * dispatch — and making the omission a `tsc` error is what keeps the effect at
   * the composition root instead of drifting back into the console's own subtree
   * as a second allowlist entry.
   *
   * `productionTriageEffects` is passed as a THUNK, not called: `--status` must
   * work on a machine with no `fleet.yaml` and no fleet, and the builder loads
   * the config and resolves a worker.
   *
   * Registered LAST, which is where it was in the loop — registration order is
   * `--help` order.
   */
  const triage = await import("./commands/triage.ts");
  triage.register(program, () => triage.productionTriageDeps(productionTriageEffects));

  // No subcommand at all did nothing and reported success. Naming no command
  // is a usage error, and an orchestrator switching on the integer has to be
  // able to tell "did nothing" from "succeeded".
  if (argv.length <= 2) {
    program.outputHelp();
    return EXIT.USAGE;
  }

  try {
    await program.parseAsync(argv);
    return EXIT.SUCCESS;
  } catch (err) {
    const code = exitCodeForError(err);
    // Commander already printed its own diagnosis; anything else gets one line
    // and never a stack trace. An undiagnosed failure says so, because the
    // reader's next move differs: file a bug, do not fix the command line.
    if (!isCommanderError(err)) {
      const what = code === EXIT.INTERNAL ? "internal error: " : "";
      process.stderr.write(
        `pifleet: ${what}${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return code;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv);
}
