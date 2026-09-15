/**
 * The `operations` workspace — the standing three-pane console this repository
 * is driven from day to day.
 *
 * ## What it is
 *
 * One cmux workspace named `operations`, holding, in order:
 *
 * | pane | title | what runs |
 * |---|---|---|
 * | 1 | `ticketing` | `pifleet up`, then the agent's live event viewer, then a container shell |
 * | 2 | `fleet-status` | a poll loop over `pifleet status` |
 * | 3 | `git-watch` | a poll loop over `git status` + `git log` in the INVOCATION directory |
 *
 * Pane 1 is the point of the thing: it stands a ticketing worker up and then
 * DROPS TO A SHELL rather than exiting, so that ticket work is handed off with
 * `pifleet dispatch --worker tick-1` into a container that is already warm.
 * A pane whose command exits is a pane cmux tears down, so the trailing
 * `exec $SHELL -i` is load-bearing and not a convenience.
 *
 * ## Where this lives, and why here rather than `src/operations/`
 *
 * Under `src/backends/cmux/` because ISC-137 confines every cmux import to
 * this directory — the seam that lets `pifleet` run on tmux or headless at
 * all. A first draft of this file sat at `src/operations/plan.ts` and imported
 * `shellQuote` from `./parse.ts`; the anti-criterion caught it. Inlining a
 * private copy of the quoting rule to get out from under the guard would have
 * been worse than the violation: two copies of a shell-quoting decision is
 * precisely the drift the rest of this module argues against. The console IS a
 * cmux artefact, so it belongs with the rest of the cmux knowledge.
 *
 * ## Why this is a plan and not a script
 *
 * Every function here is PURE — it returns argv arrays and command strings and
 * touches neither cmux nor the disk. `scripts/operations` does the I/O. That
 * split is the same one `src/backends/cmux/client.ts` argues for and for the
 * same reason: the flag IS the behaviour, so the flags have to be pinnable
 * byte-for-byte by a unit test with no cmux running. Every claim in the
 * comments below is re-checked by `test/unit/operations-plan.test.ts`.
 *
 * ## Four host facts this file is shaped by, the first three measured 2026-08-30
 *
 * - **`pifleet` is not on `PATH`.** `package.json` is `private: true` and its
 *   `bin` entry is never linked, so `which pifleet` finds nothing. Every pane
 *   therefore invokes the CLI by ABSOLUTE path, so the pane keeps working if its
 *   cwd is ever somewhere else.
 * - **`bun` IS NOT ON THE PANE'S `PATH` EITHER, measured 2026-09-12.** The rung
 *   above solved this for the SCRIPT and stopped one token short of the
 *   INTERPRETER. cmux is a GUI app launched by launchd, so it inherits
 *   launchd's environment and not a login shell's: `/Applications/cmux.app`
 *   (pid 888) carries `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, four entries, and
 *   `bun` lives at `~/.bun/bin/bun`. Every pane cmux spawns starts from that
 *   PATH, so a bare `bun` is `command not found` there while `which bun`
 *   succeeds in every terminal an operator would check it from.
 *
 *   The cost was three consoles dark and a long diagnosis: the triage panes
 *   printed `/bin/sh: bun: command not found` once per rung, fell through the
 *   `;` ladder to a bare `$SHELL`, and presented as panes that existed, were
 *   correctly titled, and ran nothing. `status` showed no run, `docker ps` no
 *   container, `cmux top` `0 procs` — every indirect probe said "not started"
 *   and none of them said why. So the interpreter is named by absolute path
 *   for exactly the reason the CLI already was.
 * - **`watch(1)` does not exist on this host.** It is a Linux/procps tool, and
 *   macOS does not ship it. The git pane is a `while` loop for that reason and
 *   must stay one; a `watch` line would fail on the first tick with
 *   `command not found` and leave a dead pane that looks configured.
 * - **`--command` text is shell-INJECTED, not exec'd** (SRD §4.1) — cmux types
 *   it into the pane's shell. So interpolating a path directly is command
 *   injection by construction, and every interpolated value below goes through
 *   `shellQuote`.
 */

import { dirname } from "node:path";
import type { SplitDirection } from "./client.ts";
import { shellQuote } from "./parse.ts";

/**
 * The workspace's `--name`, which is also the idempotency key.
 *
 * `workspace create --name` round-trips to `custom_title`, and
 * `findWorkspaceByTitle` matches THAT field and no other — `title` falls back
 * to the workspace's directory name, so matching it would adopt any workspace
 * that merely happened to be opened on a directory called `operations`.
 */
export const OPERATIONS_WORKSPACE = "operations";

/**
 * The workers pane 1 brings up when the caller names none.
 *
 * `obs-1` LEADS, and the order is load-bearing twice over: `workers[0]` is the
 * worker whose `pane_mode` decides whether the top-right pane is Pi's own
 * interface, and it is the worker that pane shows. `tick-1` follows so the same
 * `up` stands the ticketing worker up for the top-LEFT pane.
 *
 * `obs-1` is `fleet.yaml`'s console observer. It leads because the top-right is
 * the pane a human actually watches, and `observer-k8s` is the role whose work
 * is worth watching in real time — a deploy being followed through a pipeline,
 * or a service being interrogated. `tick-1`, the previous default, does its
 * work in one burst and then has nothing to show.
 *
 * `obs-1` specifically, NOT the `observer-k8s` role: the role resolves to
 * `pane_mode: rpc` and must keep doing so, because `tui` allocates no epoch and
 * an observer watch is built on re-dispatching near-identical tasks (§7.5). The
 * override lives on this ONE worker, which is the console's and is not what the
 * orchestrator re-dispatches to; `obs-2` inherits `rpc` and takes that traffic.
 * `up`'s own guard permits exactly one tui worker, so this is also the seat that
 * choice occupies.
 *
 * This is a LIST rather than a single id because `up --workers` already takes a
 * set (ISC-61) and the operations console has no business being narrower than
 * the command it drives — naming two workers here is a config edit, not a code
 * change.
 */
export const DEFAULT_OPERATIONS_WORKERS: readonly string[] = ["obs-1", "tick-1"];

/**
 * How much of the console's height the TOP row gets.
 *
 * The two top panes are the ones with something to read — an agent's own
 * interface and a second agent's rendered output. The bottom two are a status
 * table and a git log, both of which say what they have to say in a handful of
 * lines and then repeat. An even split spends half the window on the half that
 * needs least.
 *
 * Applied after the panes exist rather than as a split option, because
 * `new-split` takes no size: it halves, and the layout is corrected afterwards
 * against the container height cmux reports.
 *
 * 0.65, by owner decision 2026-09-03, superseding the 2 / 3 this replaces. The
 * requirement was stated about the BOTTOM row — 35% of the height — and this
 * constant is its complement, because the top row is the one every caller and
 * every sibling constant is written in terms of. `applyTopFraction` converts
 * where it has to: which row it moves depends on the DIRECTION of the
 * correction, since only one of the two rows has a border it can address.
 * `operations-plan.test.ts` pins the bottom share rather than this value, so
 * the requirement is what a reader sees asserted.
 */
export const OPERATIONS_TOP_FRACTION = 0.65;

/** Seconds between refreshes of the git pane. */
export const DEFAULT_GIT_POLL_SECONDS = 5;

export interface OperationsPane {
  /** `rename-tab --title`; also how a human names the pane when asking for it. */
  readonly title: string;
  /**
   * The pifleet worker this pane runs, or absent for a pane that runs none.
   *
   * **This field exists because the title is NOT the worker id on every console,
   * and one caller assumed it was.** The agent-square consoles title a pane by
   * its worker id — see the note on `title` below — so there the two are the
   * same string and the assumption is invisible. `operations` holds one worker
   * per ROLE and titles its panes `observer` and `ticketing` while running
   * `obs-1` and `tick-1`, and `monitor` runs no worker at all.
   *
   * ISC-1106 measured the cost. `scripts/operations --restart observer` passed
   * the TITLE to `resolveThenRestart`, whose only use of it is
   * `runsHoldingAny(status, {worker})` — no run holds a worker called
   * `observer`, so nothing matched, `down` was never called, and the pane was
   * respawned beside its own still-running container. Two live runs for one
   * worker id, reproduced twice an hour apart, and the console had no safe
   * restart path at all: `--restart obs-1` was refused as "not a pane this
   * console plans" and `--restart observer` orphaned.
   *
   * Carried on the PLAN rather than re-derived by each caller, because the plan
   * is the one place that already knows both halves — it puts `workers[0]` in
   * the observer pane — and a second mapping written beside it is a second
   * thing to get wrong.
   */
  readonly worker?: string;
  /** Shell text for `respawn-pane --command`. */
  readonly command: string;
  /**
   * The direction this pane is split off the PREVIOUS one, or `null` for the
   * first, which consumes the workspace's initial surface and is split off
   * nothing.
   *
   * Carried per-pane rather than derived from the index. It was
   * `i % 2 === 1 ? "right" : "down"` — an alternating sequence copied from the
   * fleet backend, where panes are interchangeable and any tiling will do.
   * These three are not interchangeable: the shape below is the requirement,
   * and a modulo cannot express it because the second split must land inside
   * the pane the first one created rather than beside it.
   *
   * ```
   * +-------------------------------+
   * |          ticketing            |   split: null   (the initial surface)
   * +---------------+---------------+
   * |  fleet-status |   git-watch   |   "down", then "right" off fleet-status
   * +---------------+---------------+
   * ```
   */
  readonly split: SplitDirection | null;
  /**
   * Which EARLIER pane this one is split off, as an index into this array.
   * Omitted means the previous pane, which is the common case.
   *
   * A 2x2 cannot be built from "always the previous one". Splitting the four
   * panes in reading order walks off the end of the shape: pane 4 has to land
   * under pane 2, not beside pane 3. So the bottom-right pane names its anchor
   * and every other pane keeps the default.
   */
  readonly splitFrom?: number;
}

export interface OperationsPlanOptions {
  /**
   * Absolute path to THIS repository — where `src/cli/index.ts` lives. Panes
   * cd nowhere, they name it.
   */
  readonly repoRoot: string;
  /**
   * The directory `scripts/operations` was invoked FROM, and the only thing
   * the git pane reports on.
   *
   * Deliberately not `repoRoot`. The operations console is a place to stand
   * while working on whatever repository you are actually in, and a git pane
   * pinned to cmux-fleet would show this repository's branch to an operator
   * looking at a different one — a wrong answer that looks like a right one,
   * which is worse than no pane. It is also what makes the workspace's `--cwd`
   * meaningful: panes 2 and 3 start where you started.
   */
  readonly watchDir: string;
  /** `up --workers` set. Defaults to {@link DEFAULT_OPERATIONS_WORKERS}. */
  readonly workers?: readonly string[];
  /** `up --config`. Defaults to `<repoRoot>/fleet.yaml`. */
  readonly configPath?: string;
  /** `up --backend`. `headless` because the fleet must not open panes of its own. */
  readonly backend?: string;
  /**
   * Which of `workers` resolve to `pane_mode: tui`, and so want Pi's own
   * interface in their pane rather than a rendered tail of their log.
   *
   * A SET, not a boolean, because each agent pane runs its OWN `up`.
   * `--attach-here` hands over the terminal of the process that runs it, and
   * one process has one terminal — `attended/adopt.ts` refuses with "can hand
   * over ONE terminal and this run has N tui workers". Two attended panes are
   * therefore two `up` invocations and two runs; no arrangement of a single run
   * gives two people two keyboards.
   *
   * `--backend headless` and `--attach-here` look contradictory and are not:
   * headless says pifleet must not open windows under the console, and
   * attach-here says the window it must not open already exists — this pane.
   * `up`'s own guards enforce the rest, so a plan that sets this on a run that
   * cannot support it produces a refusal naming the reason rather than a pane
   * that quietly does the wrong thing.
   */
  readonly tuiWorkers?: readonly string[];
  /**
   * The TITLE of the workspace these panes will live in — `operations`,
   * `development`, `review`.
   *
   * ## Why the plan carries it at all
   *
   * It reaches `up --workspace-name` and ends up in each worker's
   * `presentation.json`, which is what lets the monitor head a group with
   * `workspace review` instead of `workspace EC23CD87-CF25-46F6-8262-…`.
   *
   * **`up` cannot discover this and must not go looking.** It runs inside a
   * pane whose environment carries `CMUX_WORKSPACE_ID` and no title — probed
   * against the installed cmux 0.64.x, the binary exports
   * `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID` and `CMUX_PANE_ID` and nothing
   * else of the sort. The name lives behind `cmux workspace list`, and ISC-137
   * confines that call to this directory while `up --attach-here` needs no
   * cmux socket at all today.
   *
   * The console DOES know it, because the console is what asked cmux to create
   * or match that title. So it travels from here — one hop, no lookup, nothing
   * that can make a cosmetic label fail a run.
   *
   * ## Injected from `WorkspaceSpec.name`, not passed by hand
   *
   * `operations.ts` folds `spec.name` in at the single site that calls
   * `spec.panes`, so the title the panes advertise is by construction the title
   * `workspace create --name` used and `findWorkspace` matches on. A caller
   * that supplied its own would be a second spelling of one fact.
   *
   * `undefined` is ordinary and safe: the flag is simply omitted and the
   * monitor falls back to the workspace ref, which is what every record
   * written before this existed already does.
   */
  readonly workspaceName?: string;
  /** Git pane refresh interval. */
  readonly gitPollSeconds?: number;
}

/**
 * A worker id, backend name or any other value that reaches `up`'s argv.
 *
 * Quoting alone would make injection impossible, so this is not a security
 * control — it is a legibility one. A worker id with a space in it is a typo
 * every time, and the pane it produces fails deep inside `up` with a message
 * about an unknown worker rather than here with the value in it.
 */
const PLAIN_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertPlainValue(what: string, v: string): void {
  if (!PLAIN_VALUE_RE.test(v)) {
    throw new Error(`operations: refusing ${what} ${JSON.stringify(v.slice(0, 64))} — not a plain identifier`);
  }
}

/**
 * `bun run <repo>/src/cli/index.ts <argv…>`, fully quoted.
 *
 * Exported because it is the seam a test pins: an operations pane that invokes
 * a `pifleet` off `PATH` would work on a machine where someone had linked it
 * and nowhere else, and that difference is invisible until the pane is opened.
 */
export function pifleetCommand(
  repoRoot: string,
  argv: readonly string[],
  /**
   * The interpreter, defaulting to THE RUNNING BUN rather than the word `bun`.
   *
   * Same idiom and same reason as `src/supervisor/launch.ts:39` — "the running
   * bun binary, not whatever is on PATH". A parameter rather than an inlined
   * `process.execPath` so the string stays pinnable byte-for-byte by a unit test
   * with no cmux running, which is the property this file's header requires.
   */
  bun: string = process.execPath,
): string {
  return `${shellQuote([bun])} run ${shellQuote([`${repoRoot}/src/cli/index.ts`, ...argv])}`;
}

/**
 * One AGENT pane's whole command — the three-stage ladder, for one worker.
 *
 * Hoisted out of {@link operationsPanes} because there is now a second
 * workspace built from the same rung. Two copies of this string is two places
 * for `--attach-clear` to go missing from one of them, and the difference
 * would show only as a banner in one console and not the other.
 *
 * ## ONE `up` PER AGENT PANE, each naming only its own worker
 *
 * A single `up` naming several cannot attach them all — `--attach-here` hands
 * over the terminal of the process that runs it, and one process has one
 * terminal, so `attended/adopt.ts` refuses with "can hand over ONE terminal and
 * this run has N tui workers". N attended panes are therefore N runs, which is
 * why `status` grew `--all` and why `--recreate` stops every live run rather
 * than only the newest.
 *
 * ## The rungs, each a deliberate step down
 *
 *   1. `up`      — stand the worker up. With `attach` it ALSO hands this pane
 *                  to the worker and blocks there, so stage 1 is Pi's own
 *                  interface and stage 2 is what you drop to when you detach.
 *                  Without it, `up` returns at once and stage 2 is the pane's
 *                  whole life.
 *   2. VIEWER    — `logs --follow --render`, which BLOCKS. It sits on an idle
 *                  worker and prints events as they happen. It never exits.
 *   3. SHELL     — Ctrl-C out of the viewer and the pane is an interactive
 *                  shell INSIDE the worker's container: same mounts, same
 *                  egress policy, same absent credentials as the agent.
 *   4. host `$SHELL` — only if all three are unavailable, which in practice
 *                  means `up` refused.
 *
 * `;` and not `&&` throughout: a failed `up` must still leave a usable shell.
 * With `&&` a fleet that refuses admission closes the pane, taking the error
 * message with it. Measured on the first live run, where `up` did refuse and
 * the shell was what made the refusal readable.
 *
 * NO `--run` PINNING on the fallbacks, and that is a knowing limit. Each pane
 * creates its own run, so "the most recent run" is genuinely ambiguous between
 * panes. The fallbacks are the FAILURE path — reached only once `up` has
 * exited — and a wrong-run `logs` there fails loudly and drops to the shell
 * rung, which is what the ladder is for. The primary path, `up --attach-here`,
 * is unambiguous: it attaches the run it just made.
 */
export function agentPaneCommand(args: {
  readonly repoRoot: string;
  readonly worker: string;
  readonly backend: string;
  readonly configPath: string;
  /** Whether this worker resolves to `pane_mode: tui` and wants Pi's own UI. */
  readonly attach: boolean;
  /** The workspace title, for `--workspace-name`. See {@link OperationsPlanOptions.workspaceName}. */
  readonly workspaceName?: string | undefined;
}): string {
  const { repoRoot, worker, backend, configPath, attach, workspaceName } = args;
  const up = pifleetCommand(repoRoot, [
    "up",
    "--workers",
    worker,
    "--backend",
    backend,
    "--config",
    configPath,
    // `--attach-clear` rides with `--attach-here` and never alone. At a command
    // line `up`'s report is worth reading; in a standing pane it is a banner
    // carried above the agent for the life of the console.
    ...(attach ? ["--attach-here", "--attach-clear"] : []),
    /*
     * `--workspace-name` RIDES WITH `--attach-here` AND NEVER ALONE, and the
     * gate is on `attach` rather than merely on the name being present.
     *
     * A non-attached pane's `up` creates its own workspace (or runs headless
     * with none) and NAMES IT ITSELF — `presentedWorkspace` treats pifleet's
     * own name as authoritative there and ignores the flag outright. Emitting
     * it anyway would put a flag in the argv that the receiver is documented to
     * discard, which reads to anyone debugging a pane as though the console
     * were asking for something it is not getting.
     *
     * The emptiness check is the same one `up` applies on the other side. Two
     * guards for one fact is deliberate here: this one keeps a meaningless flag
     * out of the command an operator reads in `--dry-run`, and `up`'s keeps a
     * meaningless value out of the record on disk. Neither makes the other
     * redundant, because the argv and the record are read by different people
     * at different times.
     */
    ...(attach && workspaceName !== undefined && workspaceName !== ""
      ? ["--workspace-name", workspaceName]
      : []),
  ]);
  // `clear` first, for the LOGIN SHELL's own banner — "Last login: …" and "You
  // have mail." come from the shell cmux spawns, before any of this runs, so
  // `--attach-clear` cannot reach them and this cannot reach what `up` prints.
  // Two sources, two fixes; removing either leaves half the banner on screen.
  return (
    `clear ; ${up} ; ` +
    `${pifleetCommand(repoRoot, ["logs", "--worker", worker, "--follow", "--render"])} ; ` +
    `${pifleetCommand(repoRoot, ["shell", "--worker", worker])} ; exec $SHELL -i`
  );
}

/**
 * The three panes, in creation order.
 *
 * ORDER IS PART OF THE CONTRACT. `scripts/operations` consumes the first pane
 * from the workspace's initial surface and splits the rest off it, so pane 1
 * is the one that gets focus and the one the operator lands in.
 */
export function operationsPanes(opts: OperationsPlanOptions): OperationsPane[] {
  const repoRoot = opts.repoRoot;
  const watchDir = opts.watchDir;
  const workers = opts.workers ?? DEFAULT_OPERATIONS_WORKERS;
  const backend = opts.backend ?? "headless";
  const configPath = opts.configPath ?? `${repoRoot}/fleet.yaml`;
  const poll = opts.gitPollSeconds ?? DEFAULT_GIT_POLL_SECONDS;

  if (workers.length === 0) {
    // `up` itself refuses `--workers ""` as "an operator who meant to name
    // workers and named none". Refusing here too keeps the diagnosis at the
    // layer that knows the flag came from a plan rather than a command line.
    throw new Error("operations: refusing an empty --workers set — name at least one worker");
  }
  for (const w of workers) assertPlainValue("worker id", w);
  assertPlainValue("backend", backend);
  if (!Number.isInteger(poll) || poll < 1) {
    throw new Error(`operations: refusing git poll interval ${String(poll)} — must be a positive whole number of seconds`);
  }

  const tuiWorkers = new Set(opts.tuiWorkers ?? []);
  /*
   * The AGENT half of pane 1. `workers[0]` — the pane shows one worker, and
   * the first named is the one the console is built around (`tick-1` by
   * default). A pane trying to show all of them would be a status pane, and
   * there is already one of those below.
   */
  const agent = workers[0]!;

  /*
   * Each agent pane's own three-stage ladder. `up` for its worker, then the
   * rendered viewer, then a shell inside its container.
   *
   * NO `--run` PINNING on the fallbacks, and that is a knowing limit rather
   * than an oversight. Each pane creates its own run, so "the most recent run"
   * is genuinely ambiguous between two panes, and resolving the run that holds
   * a given worker needs more JSON handling than belongs in shell text typed
   * into a pane. The fallbacks are the FAILURE path — reached only when `up`
   * has exited — and a wrong-run `logs` there fails loudly and drops to the
   * shell rung, which is the behaviour the ladder is built for. The primary
   * path, `up --attach-here`, is unambiguous: it attaches the run it just made.
   */
  const ladder = (worker: string): string =>
    agentPaneCommand({
      repoRoot,
      worker,
      backend,
      configPath,
      attach: tuiWorkers.has(worker),
      workspaceName: opts.workspaceName,
    });

  /*
   * The SECOND agent pane. `workers[1]` when there is one — the console shows
   * two agents side by side across the top, and this is the left-hand one.
   *
   * It runs its OWN `up`, because that is the only way it can be Pi's interface
   * rather than a tail: `--attach-here` hands over the terminal of the process
   * that runs it. The cost is a second run, which `status --all` reports and
   * `--recreate` tears down.
   */
  const second = workers[1];

  return [
    {
      title: "observer",
      worker: agent,
      /*
       * THREE STAGES, each a deliberate step down, and the pane never lands on
       * a host prompt while anything above it is still available.
       *
       *   1. `up`      — stand the worker up. With `attachHere` it ALSO hands
       *                  this pane to the worker and blocks there, so stage 1
       *                  is Pi's own interface and stage 2 is what you drop to
       *                  when you detach. Without it, `up` returns immediately
       *                  and stage 2 is the whole life of the pane.
       *   2. VIEWER    — `logs --follow --render`, which BLOCKS. This is what
       *                  the pane shows for its whole life: it sits on an idle
       *                  worker waiting, and prints the agent's events as they
       *                  happen the moment something is dispatched. It does not
       *                  exit on its own.
       *   3. SHELL     — Ctrl-C out of the viewer and the pane becomes an
       *                  interactive shell INSIDE the worker's container. Same
       *                  mounts, same egress policy, same absent credentials as
       *                  the agent.
       *   4. host `$SHELL` — only if all three are unavailable, which in
       *                  practice means `up` refused.
       *
       * ## The pane is deliberately NOT a shell "to Pi", because there is no
       * ## such thing here
       *
       * `interactiveArgv`'s docblock states it: an RPC worker launches Pi with
       * the supervisor holding stdin, so attaching a human keyboard to that
       * JSONL protocol stream would corrupt the control plane on the first
       * keystroke. **That is a statement about `pane_mode: rpc`, not about
       * this pane** — a `tui` worker has no control plane to corrupt, which is
       * exactly what `attachHere` above turns on and what SRD §3.5 gave up to
       * get it. Stage 3 puts a person inside the same boundary without
       * touching Pi's pipes, which is what keeps dispatch, steer, abort and
       * harvest working while someone is typing. Talking TO the agent mid-turn
       * is `steer`; watching it is stage 2.
       *
       * `;` and not `&&` throughout: a failed `up` must still leave a usable
       * shell. With `&&` a fleet that refuses admission closes the pane, taking
       * the error message with it, and the operator is left with a workspace
       * that has a hole where its console was. Measured on the first live run,
       * where `up` did refuse and the shell was what made the refusal readable.
       */
      command: `${envPreamble()} ${ladder(agent)}`,
      // The initial surface: the whole workspace until something splits it.
      //
      // The OBSERVER holds it, not the ticketing pane on its left, and that is
      // forced rather than chosen. This is the pane that runs `up`, `up` is
      // what `--attach-here` belongs to, and `--attach-here` hands the terminal
      // to the run's single `pane_mode: tui` worker. Only the pane running `up`
      // can be Pi's own interface, so the pane that must be Pi's interface is
      // the one that starts.
      split: null,
    },
    {
      title: "monitor",
      /*
       * ONE PANE WHERE THERE WERE TWO (SRD-FLEET-MONITOR §1, ISC-488).
       *
       * `fleet-status` and `git-watch` were two shell loops, each re-running a
       * whole command on one shared `--poll` and diffing its output to decide
       * whether to repaint. Both are now regions of a single process, and the
       * thing that replaces them is not a third loop but a program with three
       * clocks: the 1777 ms run walk on 30 s, `docker ps` beside it, the git
       * strip on 5 s, and painting on its own interval so ages keep moving
       * while nothing is being re-read.
       *
       * WHAT THE MERGE HAD TO KEEP, because each was paid for on a live console
       * and none of them is recoverable by reasoning:
       *
       * - **No `watch(1)`** — a HOST fact (`:47-50`), not a pane fact. macOS
       *   ships none, so the obvious way to write a refreshing pane fails on
       *   tick one with `command not found` and leaves a dead pane that looks
       *   configured. The monitor is a bun process and cannot invoke it; the
       *   assertion survives pointed at this command, and the `--repo` flag is
       *   named that way rather than `--watch-dir` so the tripwire can stay
       *   blunt.
       * - **Clears rather than appends** — `status --watch` APPENDS, and the
       *   measured cost was a pane that became a transcript of how long a dead
       *   worker had been dead. The monitor writes cursor-home-and-clear before
       *   each frame, and only when the frame CHANGED, which is
       *   the deleted `redrawOnChange`'s behaviour carried through the
       *   rewrite.
       * - **Survives a non-zero exit** — `|| true` existed because the loop
       *   died on the first refresh after a `down`, which is exactly when an
       *   operator looks at it. Here it is the `;` before the shell rung: the
       *   monitor exiting for any reason drops to a usable shell rather than
       *   closing the pane and taking the diagnosis with it.
       * - **`-C <dir>`, never a `cd`** — the git half reports on the
       *   INVOCATION directory. `watchDir`, never `repoRoot`; see the field's
       *   docblock. It is passed as `--repo` and reaches `git -C` unchanged.
       *
       * `--poll` KEEPS ITS NAME AND CHANGES ITS MEANING, which ISC-490 requires
       * be stated rather than left dangling. It used to be the read interval
       * for two loops; it is now the REPAINT interval for one process whose
       * reads are on their own clocks. The operator-visible behaviour it
       * governs — how quickly the pane reflects a change — is the same, which
       * is why it keeps the name instead of being retired.
       */
      command: `${pathPreamble()}${monitorPaneCommand(repoRoot, poll)}; exec $SHELL -i`,
      /*
       * DOWN off the OBSERVER, and SECOND in creation order — which is what
       * makes it span the WHOLE bottom rather than a column of it.
       *
       * **The first split decides the major axis, and that is the entire
       * reason this pane is created before `ticketing` rather than after it.**
       * Built third, it could only ever split one column: by then the surface
       * has already been divided left/right and there is no surface left that
       * spans both. Built second, it splits the untouched workspace
       * horizontally, `ticketing` then divides the TOP half, and the monitor
       * keeps the full width.
       *
       *   +---------------+---------------+
       *   |   ticketing   |   observer    |
       *   +-------------------------------+
       *   |            monitor            |
       *   +-------------------------------+
       *
       * The cost is that pane order is no longer reading order, which is why
       * `operations-plan.test.ts` resolves panes BY TITLE — a title is what a
       * pane IS, its index is where it happened to land.
       */
      split: "down",
    },
    ...(second === undefined
      ? []
      : [
          {
            title: "ticketing",
            worker: second,
            /*
             * The same three-stage ladder the observer pane uses, for this
             * pane's own worker and its own run. See `second` above for why it
             * runs its own `up` rather than sharing one.
             */
            command: `${envPreamble()} ${ladder(second)}`,
            /*
             * LEFT of the OBSERVER — pane index 0 — and it cannot use the
             * default anchor. The pane before it is now the monitor, and
             * splitting that would put ticketing in the bottom row.
             *
             * **This revives `splitFrom`, which the pane merge had left without
             * a caller.** It existed so `git-watch` could reach the observer
             * rather than its predecessor; the same need reappears here for the
             * same structural reason, one pane later.
             */
            split: "left" as const,
            splitFrom: 0,
          },
        ]),
  ];
}

/**
 * The `development` workspace's `--name`, and its idempotency key.
 *
 * Exact-matched on `custom_title` for the reason {@link OPERATIONS_WORKSPACE}
 * records. The two consoles are siblings and must never adopt each other, which
 * exact matching on two distinct names gives for free.
 */
export const DEVELOPMENT_WORKSPACE = "development";

/**
 * The four workers the development console stands up, in PANE ORDER.
 *
 * ```
 * +---------------+---------------+
 * |     eng-1     |     eng-2     |
 * +---------------+---------------+
 * |     tst-1     |     tst-2     |
 * +---------------+---------------+
 * ```
 *
 * Two engineers on top because that is the pair a person actually alternates
 * between — two changes in flight, each with its own container and its own
 * branch. The two testers sit under them because their work is downstream of
 * it and is read in bursts rather than watched. The second of them was a
 * `reviewer` seat until 2026-09-05; review is the `review` console's job now,
 * and `fleet.example.yaml`'s comment on that seat records what the swap costs.
 *
 * ALL FOUR ARE ATTENDED, which is the whole difference from `operations`: this
 * console is four keyboards, so it is four runs. `status --all` is what reports
 * them together and `--recreate` is what tears them down; there is no
 * arrangement of one run that gives four panes four keyboards.
 *
 * THE COST, stated plainly: four attended workers plus the operations
 * console's two is six Pi processes against one oMLX server, and
 * `run.max_concurrent` bounds each RUN rather than the host. Admission control
 * cannot queue across runs, so six panes generating at once is six concurrent
 * requests. That is a throughput decision the operator makes by opening this
 * console, not something the plan can bound.
 */
export const DEFAULT_DEVELOPMENT_WORKERS: readonly string[] = [
  "eng-1",
  "eng-2",
  "tst-1",
  "tst-2",
];

/**
 * The development console's panes are EQUAL, and `null` says so.
 *
 * `new-split` halves, so four panes built as two columns each split once are
 * already four quarters — the correction {@link OPERATIONS_TOP_FRACTION} exists
 * for is one this layout does not need. `null` skips the resize entirely rather
 * than asking for a fraction of `1/2` and relying on the sub-pixel guard to
 * make it a no-op: a value that happens to round to nothing is indistinguishable
 * from one that was computed wrongly, and this is a stated requirement.
 *
 * The operations console is uneven on purpose because its bottom row is a
 * status table and a git log — two panes that say their piece in a handful of
 * lines. Every pane here is an agent, so every pane has as much to show as
 * every other, and there is nothing to favour.
 */
export const DEVELOPMENT_TOP_FRACTION: number | null = null;

/** The largest 2x2 there is. A fifth pane has nowhere in this shape to go. */
const SQUARE_MAX_PANES = 4;

/**
 * The development console's panes, in creation order.
 *
 * ORDER IS PART OF THE CONTRACT, as it is for {@link operationsPanes}: pane 1
 * consumes the workspace's initial surface, and is the pane the operator lands
 * in.
 *
 * ## Why the split sequence is a table and not a rule
 *
 * A 2x2 cannot be built from "always split the previous pane". Walking the four
 * in reading order runs off the shape at pane 4, which has to land under pane 2
 * rather than beside pane 3 — so the bottom row names its anchor explicitly.
 * `operationsPanes` learned the same lesson at its git pane; this is that
 * knowledge applied to a layout that is 2x2 all the way down:
 *
 * ```
 *   1: the initial surface          2: "right" off 1
 *   3: "down" off 1  (splitFrom 0)  4: "down" off 2  (splitFrom 1)
 * ```
 *
 * Fewer than four workers degrades to the prefix of that sequence rather than
 * refusing, so `--workers eng-1,eng-2` gives a clean side-by-side pair. More
 * than four IS refused: there is no fifth quarter, and silently stacking a
 * third row would produce a console that does not match its own docblock.
 */
export function developmentPanes(opts: OperationsPlanOptions): OperationsPane[] {
  return agentSquarePanes(opts, DEFAULT_DEVELOPMENT_WORKERS, "development");
}

/**
 * A 2x2 of attended agent panes — `development`'s shape, and since 2026-09-13
 * ONLY `development`'s.
 *
 * **IT WAS EXTRACTED BECAUSE `review` SHARED IT, AND `review` HAS SINCE LEFT**
 * for {@link collatorOverRowPanes}, so this function now has exactly one caller.
 * That is recorded here rather than left for a reader to discover by grepping
 * and finding a "shared" builder shared with nobody. It is KEPT rather than
 * inlined because the argument below is about where a fragile table lives, and
 * that argument does not depend on the number of callers — but if `development`
 * ever changes shape too, this should be deleted rather than left standing as a
 * builder nothing builds with.
 *
 * The original extraction argument, which still explains the table's shape:
 * a 2x2 cannot be built from "always split the previous pane", pane 4 has to
 * name pane 2 as its anchor, and `operationsPanes` already learned that lesson
 * separately at its git pane. A copied table is a second place to get that
 * backwards, and the two copies would be identical on the day they were written
 * and only diverge afterwards — which is exactly the drift the Dockerfile's
 * `toolchain-full` stage was carrying when it was folded into its siblings.
 * {@link collatorOverRowPanes} was extracted on that same reasoning the moment
 * `review` became the second console of ITS shape.
 *
 * `label` is the console's name and appears ONLY in the refusals, because a
 * refusal that does not say which console refused sends the operator to check
 * the wrong `--workers` flag.
 */
export function agentSquarePanes(
  opts: OperationsPlanOptions,
  defaultWorkers: readonly string[],
  label: string,
): OperationsPane[] {
  const repoRoot = opts.repoRoot;
  const workers = opts.workers ?? defaultWorkers;
  const backend = opts.backend ?? "headless";
  const configPath = opts.configPath ?? `${repoRoot}/fleet.yaml`;

  if (workers.length === 0) {
    throw new Error(`${label}: refusing an empty --workers set — name at least one worker`);
  }
  if (workers.length > SQUARE_MAX_PANES) {
    throw new Error(
      `${label}: refusing ${workers.length} workers — the console is a 2x2 and holds ` +
        `at most ${SQUARE_MAX_PANES}`,
    );
  }
  for (const w of workers) assertPlainValue("worker id", w);
  assertPlainValue("backend", backend);

  const tuiWorkers = new Set(opts.tuiWorkers ?? []);

  // Index 0 is `split: null` and takes the initial surface; the rest are read
  // straight off this table. Kept beside the docblock's diagram deliberately —
  // the two have to agree, and they cannot if the sequence is computed.
  const shape: readonly { split: SplitDirection; splitFrom?: number }[] = [
    { split: "right" },
    { split: "down", splitFrom: 0 },
    { split: "down", splitFrom: 1 },
  ];

  return workers.map((worker, i) => ({
    // TITLED BY WORKER ID, not by role, and these consoles are why they differ
    // from `operations` on it. `operations` holds one worker per role and can
    // call a pane `observer`; `development` holds TWO engineers and `review`
    // holds THREE reviewers, so a role title would print the same word on
    // several panes and leave the operator guessing which container a pane
    // belongs to. The id is also what `dispatch --worker` takes, so the title
    // is the argument.
    title: worker,
    worker,
    command: `${envPreamble()} ${agentPaneCommand({
      repoRoot,
      worker,
      backend,
      configPath,
      attach: tuiWorkers.has(worker),
      workspaceName: opts.workspaceName,
    })}`,
    ...(i === 0 ? { split: null } : shape[i - 1]!),
  }));
}

/**
 * A COLLATOR ACROSS THE TOP with its workers in ONE ROW beneath — the shape
 * BOTH `triage` and `review` are, built once.
 *
 * ```
 * +-----------------------------------+
 * |              pane 1               |
 * +----------+-----------+------------+
 * |  pane 2  |  pane 3   |   pane 4   |
 * +----------+-----------+------------+
 * ```
 *
 * **Extracted 2026-09-13, when `review` became the second console of this
 * shape** — which is the trigger {@link agentSquarePanes} names for extracting
 * over copying, applied to a different shape. `triage` reached it first and
 * carried the only implementation for a day; a hand copy into `reviewPanes`
 * would have been identical on the day it was written and free to diverge
 * afterwards.
 *
 * **This is NOT {@link agentSquarePanes} with a shorter list, and that is the
 * whole reason it exists.** The square's table is `[right, down·from0,
 * down·from1]`, which makes pane 2 the top row's second half — so pane 1 can
 * never span the container. A collator over N workers needs the first split to
 * go DOWN off pane 1 and every later one to go RIGHT along the row that split
 * created. The two tables are not a parameterisation of each other; they are
 * different consoles.
 *
 * The anchor discipline is the part that actually breaks under copying, so it
 * is explicit here: every entry after the first names the pane it divides via
 * `splitFrom`, rather than relying on creation order meaning "the previous
 * one". That is the lesson `operationsPanes` learned at its git pane and the
 * square states at its own table.
 *
 * `label` appears ONLY in the refusals, because a refusal that does not say
 * which console refused sends the operator to check the wrong `--workers` flag.
 */
export function collatorOverRowPanes(
  opts: OperationsPlanOptions,
  defaultWorkers: readonly string[],
  label: string,
): OperationsPane[] {
  const repoRoot = opts.repoRoot;
  const workers = opts.workers ?? defaultWorkers;
  const backend = opts.backend ?? "headless";
  const configPath = opts.configPath ?? `${repoRoot}/fleet.yaml`;

  if (workers.length === 0) {
    throw new Error(`${label}: refusing an empty --workers set — name at least one worker`);
  }
  if (workers.length > SQUARE_MAX_PANES) {
    throw new Error(
      `${label}: refusing ${workers.length} workers — the console holds at most ` +
        `${SQUARE_MAX_PANES}: one collator and its workers`,
    );
  }
  for (const w of workers) assertPlainValue("worker id", w);
  assertPlainValue("backend", backend);

  const tuiWorkers = new Set(opts.tuiWorkers ?? []);

  return workers.map((worker, i) => ({
    title: worker,
    worker,
    command: `${envPreamble()} ${agentPaneCommand({
      repoRoot,
      worker,
      backend,
      configPath,
      attach: tuiWorkers.has(worker),
      workspaceName: opts.workspaceName,
    })}`,
    /*
     * Pane 1 takes the initial surface. Pane 2 splits DOWN off it, creating the
     * bottom row; panes 3 and 4 split RIGHT off the pane before them, walking
     * along that row. Anchored by index rather than by "the previous pane" for
     * the reason the square's table states: creation order is what gets read
     * backwards.
     */
    ...(i === 0
      ? { split: null }
      : i === 1
        ? { split: "down" as const, splitFrom: 0 }
        : { split: "right" as const, splitFrom: i - 1 }),
  }));
}

/**
 * Load `~/.env` into pane 1 before `up` runs, if it is there.
 *
 * `up` reads the model credential (`llm.api_key_env`, `OMLX_API_KEY`) and every
 * name on `secrets.env_allowlist` from ITS OWN environment, and hands what it
 * finds to the workers. Measured on the first live run: the key is in `~/.env`,
 * no shell profile sources that file, and `up` therefore warned that the worker
 * "will only reach a server that needs none" — which is every request refused
 * with a 401 against an endpoint that does need one.
 *
 * `set -a` because `up` is a CHILD: a sourced variable that is not exported is
 * invisible to it, which would reproduce the same failure with the file read.
 * The `[ -f ]` guard makes this a no-op where the file does not exist rather
 * than an error line in a pane the operator is about to work in.
 *
 * **THIS PUTS THE WHOLE FILE IN THE PANE'S ENVIRONMENT, not a chosen subset.**
 * That is the operator's own login-shell material and the same thing they would
 * type by hand, so the pane is no more exposed than their terminal is. What
 * bounds the WORKER is unchanged and is elsewhere: `secrets.env_allowlist` is
 * the ceiling on what may cross into a container, and a name absent from it
 * does not reach one however it got into this shell.
 */
export function envPreamble(
  /**
   * The `PATH` the pane runs with, defaulting to THE LAUNCHING SHELL'S OWN.
   *
   * ## Why a pane needs to be told its PATH at all
   *
   * The fourth host fact in this file's header, and the reason it is handed over
   * here rather than patched at each call site. cmux is a GUI app started by
   * launchd, so it carries `PATH=/usr/bin:/bin:/usr/sbin:/sbin` and every pane it
   * spawns inherits those four entries. On this host that is enough for `git`
   * (`/usr/bin/git`) and enough for nothing else the fleet needs: `bun` is at
   * `~/.bun/bin/bun` and `docker` at `/opt/homebrew/bin/docker`.
   *
   * MEASURED 2026-09-12, both directions, same host and same binary:
   *   env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin docker version  -> env: docker:
   *                                                                No such file
   *   docker version                                            -> 28.4.0
   *
   * ## Why here and not at the `docker` call sites
   *
   * `"docker"` is spelled at seventeen sites across ten modules, and
   * `contracts.ts:505-509` already argues against matching that string around the
   * codebase. Resolving each one would be seventeen edits to fix one fact about
   * the ENVIRONMENT, and it would fix only the binaries someone remembered — the
   * pane found `bun` missing first and `docker` only once `bun` was fixed, so the
   * list of what is missing is not knowable in advance. One PATH, handed over
   * once, covers every binary the fleet shells out to including the next one.
   *
   * This is a HANDOVER and not a widening: the console is being launched BY the
   * operator's shell, so the pane running with that shell's PATH is the pane
   * behaving as if they had typed the command themselves — which is exactly the
   * argument the `~/.env` half of this function already makes below.
   *
   * ## DIRECTORIES TO PREPEND, never the whole inherited PATH
   *
   * The first version of this handed over `process.env.PATH` entire. It worked
   * and it was wrong: this operator's PATH is 789 characters, which took the
   * pane command to 1392 and past the 1024-character cap `assertCmuxText`
   * (`client.ts:45`) applies to every free-text value this system sends to a
   * pane backend. `operations-plan.test.ts`'s "every command is something cmux
   * will accept" case caught it. The live path does NOT call that guard, so the
   * over-long command was accepted by cmux and the breach would have shown up
   * only as a mystery on some future longer PATH.
   *
   * So: the directories holding the binaries the fleet shells out to, resolved
   * in the LAUNCHING shell where they are on PATH, prepended to whatever the
   * pane already had. Two entries instead of twenty, `"$PATH"` left expanding at
   * pane time so nothing inherited is discarded.
   *
   * A parameter rather than an inlined lookup so the string stays pinnable
   * byte-for-byte by a unit test on any machine, matching
   * {@link pifleetCommand}'s interpreter argument. An empty list means "say
   * nothing", which keeps a bare `PATH=` out of a pane.
   */
  pathPrefix: readonly string[] = fleetBinDirs(),
): string {
  return `${pathPreamble(pathPrefix)}set -a; [ -f "$HOME/.env" ] && . "$HOME/.env"; set +a;`;
}

/**
 * The directories holding `bun` and `docker`, resolved in the LAUNCHING shell.
 * {@link envPreamble}'s parameter docblock is the argument for both halves.
 */
function fleetBinDirs(): string[] {
  const docker = Bun.which("docker");
  return [dirname(process.execPath), ...(docker === null ? [] : [dirname(docker)])];
}

/**
 * The `PATH` half of {@link envPreamble} on its own, for a pane that needs the
 * fleet's binaries and nothing from `~/.env`.
 *
 * The monitor pane is that pane. It runs `docker ps` on every container refresh,
 * and it was the one pane built without a preamble — so it ran on launchd's
 * four-entry PATH and painted `docker unavailable: Executable not found in
 * $PATH: "docker"` beneath a fleet whose containers were all up. MEASURED
 * 2026-09-13. It takes the PATH and not the `~/.env` source because it reads no
 * credential, and a process that needs a directory list should not be handed
 * the operator's secrets file to get one.
 *
 * Ends in a space so it prefixes a command directly; an empty list says nothing,
 * which keeps a bare `PATH=` out of a pane.
 */
export function pathPreamble(pathPrefix: readonly string[] = fleetBinDirs()): string {
  const dirs = pathPrefix.filter((d) => d !== "");
  return dirs.length === 0 ? "" : `export PATH=${shellQuote([dirs.join(":")])}:"$PATH"; `;
}


/**
 * The merged monitor pane's command (ISC-488, ISC-489, ISC-490).
 *
 * Exported so the criteria that survived the pane merge have something to
 * assert against directly — a string built inline inside `operationsPanes` can
 * only be tested through the whole plan. The two functions this replaces,
 * `statusWatchCommand` and `gitWatchCommand`, were exported for the same reason
 * and are DELETED rather than kept: after the merge nothing called them, and a
 * pair of shell-loop builders surviving beside the process that replaced them
 * would be the dead-field shape `contracts.ts:86-118` records — with the added
 * cost that a reader could not tell which one the console actually runs.
 *
 * `pifleetCommand` and therefore an ABSOLUTE path through `bun run`, never a
 * bare `pifleet`. `:43-46` records the host fact: the bin is never linked, so a
 * bare invocation fails with `command not found` in a pane that looks correctly
 * configured — the same failure shape as `watch(1)`, from a different cause.
 */
export function monitorPaneCommand(repoRoot: string, pollSeconds: number): string {
  /*
   * `--repo` is GONE, with the monitor's git region (2026-09-04).
   *
   * It existed for one consumer: `git -C <watchDir>` inside the strip that
   * reported the invocation directory's `git status` beside the fleet table.
   * With the region removed nothing downstream reads it, and a flag that is
   * accepted and ignored is worse than one that is absent — it tells an
   * operator the pane is watching a directory it is not.
   *
   * `--poll` keeps its name and its meaning: the repaint interval.
   */
  return pifleetCommand(repoRoot, ["monitor", "--poll", String(pollSeconds)]);
}



// ---------------------------------------------------------------------------
// The `review` console — a collator and three reviewers (SRD-REVIEW-CONSOLE)
// ---------------------------------------------------------------------------

/**
 * The `review` workspace's `--name`, and its idempotency key.
 *
 * Exact-matched on `custom_title` for the reason {@link OPERATIONS_WORKSPACE}
 * records. Three consoles now share one builder and must never adopt each
 * other, which exact matching on three distinct names gives for free.
 */
export const REVIEW_WORKSPACE = "review";

/**
 * The four workers the review console stands up, in PANE ORDER.
 *
 * ```
 * +-------------------------------------------+
 * |                   col-1                   |
 * +---------------+-------------+-------------+
 * |   rev-arch-1  |  rev-ctx-1  |  rev-lang-1 |
 * +---------------+-------------+-------------+
 * ```
 *
 * **THIS WAS A 2x2 UNTIL 2026-09-13**, and the diagram above replaced one. The
 * console was changed to match `triage` on the operator's request — one
 * collator across the top, its three workers in a row beneath — and the two
 * now share {@link collatorOverRowPanes} rather than each carrying a table.
 *
 * THE COLLATOR IS PANE 1, and that placement is the contract rather than a
 * preference: pane 1 consumes the workspace's initial surface and is where the
 * operator lands. This console is driven by talking to the collator — it writes
 * the three briefs and reads the three reports back — so the seat the keyboard
 * arrives in is the one seat a person actually types into. The new shape
 * STRENGTHENS that: the collator is no longer one quarter in a corner, it is
 * the row the eye starts on.
 *
 * THE THREE REVIEWERS RUN THREE DIFFERENT VENDORS, which is the whole product
 * of the console and not a detail of it. `rev-arch-1` is on `deepseek-v4-pro`,
 * `rev-ctx-1` on `qwen3.5:397b`, `rev-lang-1` on `kimi-k3`; the assignment and
 * its measurements are argued in `fleet.yaml`. Three seats on ONE model would
 * be one reviewer with three transcripts, and a shared training blind spot
 * would be invisible by construction — so a `--workers` set that collapses them
 * onto one model is a real loss even though nothing here can detect it.
 *
 * ALL FOUR ARE ATTENDED, as in `development`: four keyboards, therefore four
 * runs. `status --all` reports them together and `--recreate` tears them down.
 *
 * THE COST, stated plainly and differently from `development`'s: these four are
 * HOSTED. They do not queue behind the operator's own oMLX, so opening this
 * console does not slow the local fleet — it spends money instead, against
 * `OLLAMA_API_KEY`, and four attended panes generating at once on three of the
 * largest models in the catalogue is not a console to leave open idly.
 */
export const DEFAULT_REVIEW_WORKERS: readonly string[] = [
  "col-1",
  "rev-arch-1",
  "rev-ctx-1",
  "rev-lang-1",
];

/**
 * The collator's row gets one third of the container's height.
 *
 * **THIS WAS `null`, AND THE DOCBLOCK ARGUING FOR IT IS REPLACED RATHER THAN
 * PATCHED, because what changed is the REQUIREMENT and not the arithmetic.**
 * The old text rested on a stated ask — *"four equally sized panes in a
 * square"* — and reasoned correctly from it: `new-split` halves, two columns
 * each split once are already four quarters, so `null` skipped a resize that
 * would have been a no-op. Every step of that held. The operator asked for a
 * different console on 2026-09-13, so the premise is withdrawn, not refuted.
 *
 * That is the distinction worth keeping: a value can stop being right because
 * somebody changed their mind about the goal, and a docblock that reads as if
 * the old argument were WRONG teaches the next reader to distrust reasoning
 * that was sound. It was not wrong. It is superseded.
 *
 * **The number is defensible only while {@link reviewPanes} builds one
 * full-width row over another** — the same standing condition
 * {@link TRIAGE_TOP_FRACTION} states about itself, and for the same reason. If
 * the collator ever shares its row again, this goes back to `null`.
 *
 * ## Why a third, when the old text said there was nothing to favour
 *
 * The old docblock's observation survives and now cuts the other way. It noted
 * the collator has three reports to show and each reviewer has one, and
 * concluded that is "not a difference in HEIGHT, it is a difference in how
 * often you scroll." True of four equal quarters. Once the collator owns a full
 * row on its own, the comparison is no longer collator-versus-reviewer, it is
 * ONE settled document against THREE reviews being written at once — and three
 * panes of live work want the room. Same asymmetry {@link TRIAGE_TOP_FRACTION}
 * names between its collator and its observers.
 */
export const REVIEW_TOP_FRACTION: number | null = 1 / 3;

/**
 * How much of the container's WIDTH each pane in the reviewer row gets.
 *
 * One fraction applied per pane rather than a per-pane table, for the reason
 * {@link TRIAGE_OBSERVER_WIDTH_FRACTION} states at length: the requirement is
 * EQUALITY rather than a chosen distribution, and a table of three numbers that
 * must keep summing to one is a thing the first edit adding a fourth reviewer
 * would leave summing to more.
 *
 * The three reviewers run three different vendors and are read side by side —
 * the whole product of this console is the DISAGREEMENT between them — so a row
 * where one lens is wider than another invites reading it as the important one.
 */
export const REVIEW_REVIEWER_WIDTH_FRACTION: number | null = 1 / 3;

/**
 * The review console's panes, in creation order: the collator across the top,
 * its three reviewers in a row beneath.
 *
 * **Stopped being a 2x2 on 2026-09-13** and stopped sharing
 * {@link agentSquarePanes} with it, on the operator's request that this console
 * match `triage` visually. It now shares {@link collatorOverRowPanes} with
 * `triage` instead — which was extracted in the same change, because this is
 * the second console of that shape and copying `triagePanes`' table would have
 * been the drift the square's own docblock warns about.
 *
 * **One consequence worth stating rather than leaving to be discovered:
 * {@link agentSquarePanes} now has exactly ONE caller,
 * {@link developmentPanes}.** It was extracted precisely because a second
 * console shared its shape, and that justification is now gone. It is kept
 * because `development` genuinely is a 2x2 and the anchor lesson in its table
 * is worth keeping in one place — but a reader wondering why a "shared" builder
 * is shared with nobody deserves the answer here.
 */
export function reviewPanes(opts: OperationsPlanOptions): OperationsPane[] {
  return collatorOverRowPanes(opts, DEFAULT_REVIEW_WORKERS, "review");
}

// ---------------------------------------------------------------------------
// The `triage` console — two reconcilers, each over its own observer (SRD-TRIAGE-CONSOLE)
// ---------------------------------------------------------------------------

/**
 * The `triage` workspace's `--name`, and its idempotency key.
 *
 * Exact-matched on `custom_title` for the reason {@link OPERATIONS_WORKSPACE}
 * records. FOUR consoles now share one adoption rule and must never adopt each
 * other, which exact matching on four distinct names gives for free — and this
 * is the console where a mis-adoption would be quietest, because it is the one
 * nobody is sitting in front of.
 */
export const TRIAGE_WORKSPACE = "triage";

/**
 * The four workers the triage console stands up, in PANE ORDER.
 *
 * ```
 * +-----------------------------------+
 * |               tri-1               |
 * +----------+-----------+------------+
 * |  obs-t1  |  obs-t2   |   obs-t3   |
 * +----------+-----------+------------+
 * ```
 *
 * ONE COLLATOR OVER THREE OBSERVERS as of 2026-09-13, and the ORDER is what puts
 * the collator across the top rather than in a corner. {@link triagePanes}' own
 * table is `[null, down-from-0, right-from-1, right-from-2]`: pane 1 takes the
 * workspace's initial surface, pane 2 splits `down` off it to create the
 * observer row, and panes 3 and 4 walk `right` along that row. The collator
 * must therefore be FIRST; any other position and the full-width pane holds an
 * observer.
 *
 * **THIS DOCBLOCK HAS NOW DESCRIBED THREE DIFFERENT CONSOLES, and the last two
 * were wrong at the moment they were read rather than when they were written.**
 * It described a collator beside one observer, then a 2x2 of two pairs whose
 * argument turned on {@link agentSquarePanes}' split table — a table this
 * console no longer uses. It also asserted that {@link TRIAGE_TOP_FRACTION}
 * *"survives this change rather than becoming a number"*; that constant is now
 * `1/3`. Both claims went stale in place, with nothing to redden, because a
 * prose diagram is not checked against the list beneath it. `triage-plan.test.ts`
 * pins the shape; this paragraph is the warning that the PICTURE is not pinned.
 *
 * THE COLLATOR IS PANE 1, on {@link DEFAULT_REVIEW_WORKERS}' precedent and for a
 * weaker version of its reason. Pane 1 consumes the workspace's initial surface
 * and is where the operator lands. Nobody drives this console by typing — see
 * the fraction below — but somebody DEBUGS it, and `tri-1` is the seat that
 * holds the reconciliation the observers feed, so it is the pane worth landing
 * on when a sweep has said something surprising.
 *
 * ## WHY TWO PAIRS — and why `soleEnvironment` did NOT have to be lifted
 *
 * **This docblock said the opposite until 2026-09-12, and the correction is
 * worth keeping rather than overwriting silently.** It argued that the fan-out
 * was one wide because the thing it fans out over is one wide, and that *"a
 * second observer seat is therefore not a worker line; it is that refusal being
 * lifted first"* — the refusal being `soleEnvironment`
 * (in `src/cli/commands/triage.ts`), which quotes SRD-TRIAGE-CONSOLE §12: *"one
 * sweep is ONE environment, and that is a limit rather than a law"*.
 *
 * That inference was wrong, and the reason is worth stating because it is the
 * whole shape of this change. §12's limit binds ENVIRONMENTS, not SEATS. A
 * second pair does not need a second environment; it needs a second SLICE of the
 * one environment — and the slice is a thing this console already had a
 * vocabulary for. Splitting by environment would have been the damaging way to
 * get here: `environment` is a path segment under `~/.pifleet/triage/` and the
 * scope every incident is reported against, so inventing two tokens for one
 * cluster would make the console *"report health for a fleet"* — precisely the
 * failure `soleEnvironment`'s own docblock exists to refuse. It stays.
 *
 * What actually carries the split is that the collator never reads
 * `triage/targets.yaml`: `roles/triage.md` tells it *"Read the envelope, and read
 * it as the whole of your input. It carries the environment, the full service
 * list…"*, and that list is `SweepProducerDeps.services`, rendered by
 * `renderSweepEnvelope`. So each collator is handed its own slice as its whole
 * world, with `declared` narrowed to match — which keeps §6.5's completeness
 * check meaningful per pair instead of making each pair fail the other's half.
 *
 * SRD §2.1 is the corroboration that this is a seam rather than a new idea: the
 * roster it specifies is `{collators: ["tri-1"], reviewers: ["obs-t1", "obs-t2",
 * "obs-t3"]}`. The multi-observer shape is the ORIGINAL design the console later
 * shrank away from; this restores two of it, paired.
 *
 * `tri-1` RECONCILES AND `obs-t1` OBSERVES, which is the review console's
 * collator/reviewer shape reappearing over a different role pair (the
 * `triage:` and `observer-k8s:` keys of `fleet.example.yaml`'s `roles:` map).
 * That is not a coincidence and it is already load-bearing elsewhere:
 * `ConsoleRoster` (in `src/run/dispatch-request.ts`) was written over the two
 * ROLES rather than over `col-1`, so `TRIAGE_CONSOLE_ROSTER` needed no schema
 * change, no new refusal and no branch — SRD-TRIAGE-CONSOLE D5's bet, collected
 * once already. **The seat count moving is the bet paying a second time**: a
 * roster spelled against three literal observer ids would have had to be
 * re-derived when the console shipped at one, whereas a rule written over the
 * ROLE says the same true thing at one seat and at three.
 *
 * NEITHER SEAT IS ATTENDED, and that is the whole difference from `development`
 * and `review`. Both of those are four keyboards and therefore four runs; this
 * console is ONE run of `rpc` seats
 * (`pifleet up --workers tri-1,obs-t1,obs-t2,obs-t3`, spelled that way in
 * `fleet.example.yaml`'s "ONE RUN" comment), because a console that
 * dispatches on a clock — 96 sweeps a day at `triage/console.yaml`'s
 * `cadence_s: 900`, 288 at the schema default of 300 — cannot afford a `tui`
 * seat: `tui` allocates no epoch, so without the `already_completed` fence a
 * re-dispatched sweep runs twice, `dispatch --auto` refuses a `tui` worker
 * outright (`pane_mode_tui_is_not_auto_schedulable`), and closing the pane stops
 * the worker. SRD-TRIAGE-CONSOLE §2.2, §2.3.
 *
 * **THAT PARAGRAPH IS ABOUT THE TRACKED EXAMPLE, AND THE LIVE FLEET DISAGREES
 * WITH IT. Checked 2026-09-11 and recorded here so the next reader does not
 * re-litigate it.** In `fleet.example.yaml` neither seat carries a worker-level
 * override (find `{id: tri-1,` and `{id: obs-t1,` by name), so both resolve to
 * `pane_mode: rpc` from their roles and the plan this file builds is genuinely
 * the unattended one described above. The operator's `fleet.yaml` — TRACKED
 * since 2026-09-12, so this divergence is now a diff rather than a report of one
 * — overrides both to `tui`, and `triage/console.yaml` says so in its
 * own words and pays the stated price — `recycle_after_sweeps: 0`, because
 * §6.6's recycle is a headless `up` that takes a `tui` seat down and cannot
 * bring it back. **Do not reconcile this docblock against the live file.** What
 * this constant documents is the plan built from the tracked example; the
 * divergence is a config decision, and it belongs to whoever owns that file.
 *
 * **The plan cannot ENFORCE any of it, and the enforcement is not missing — it
 * is elsewhere, twice.** `tuiWorkers` is a caller's argument, so a driver that
 * passed these two would get two attended panes out of this function. What stops
 * it is the config (the example's roles, above) and `up`'s own one-tui-worker
 * guard. What this plan owns is the DEFAULT: name no `tuiWorkers` and no pane
 * carries `--attach-here`, which is the opposite disposition from
 * `scripts/review`.
 *
 * THE COST, stated as its two siblings state theirs — and it is the one line
 * here that got CHEAPER rather than merely shorter. One run at
 * `run.max_concurrent: 4` (in `fleet.example.yaml`) is an admission budget of
 * four spent by FOUR seats, so this console fits exactly with nothing spare —
 * which is the size that key was raised for, not a size it has outgrown. Its own
 * comment says so: *"The triage console is the first run holding four seats, and
 * three of them fan out at once"*, text written for this shape that outlived the
 * 2026-09-11 shrink to one pair and became correct again on 2026-09-12.
 *
 * **This paragraph claimed SLACK between those two dates and no longer does.**
 * The slack was real while the console held two seats and is gone now. Do not
 * lower this key by reading either version: it bounds a RUN rather
 * than the host, and a hand-run `up` over a wider worker set is the same run.
 */
export const DEFAULT_TRIAGE_WORKERS: readonly string[] = [
  "tri-1",
  "obs-t1",
  "obs-t2",
  "obs-t3",
];

/**
 * How much of the console's height the COLLATOR's row gets: one third, by owner
 * decision 2026-09-13.
 *
 * ## THIS WAS `null`, AND THE ARGUMENT FOR `null` WAS NOT WRONG — IT EXPIRED
 *
 * The block this replaces ran to a hundred lines and concluded that a fraction
 * here was *structurally inexpressible*. Its reasoning was sound and its premise
 * was load-bearing and single: **`applyTopFraction` moves the border BETWEEN
 * ROWS, and this console had ONE ROW.** `tri-1` and `obs-t1` sat side by side;
 * the shared builder's `down` entries begin at pane 3, which a two-seat console
 * never reached. With no second row there is no border, and a fraction has
 * nothing to move.
 *
 * That premise died with {@link triagePanes}' rewrite. The collator now takes
 * the full width and the observers sit beneath it, so there IS a border between
 * two rows and a fraction is expressible for the first time. The old docblock
 * even named this as the trigger — *"whatever this console gained third would
 * create a second row and make a fraction expressible"* — and it deserves the
 * credit: it forecast the condition precisely, and the forecast is why this edit
 * is a value change rather than a rediscovery.
 *
 * **The lesson worth carrying forward is about the SHAPE of that argument, not
 * its conclusion.** It was a long, confident case resting on one structural fact
 * that a later edit removed, and nothing connected the two — no test, no type,
 * nothing that reddened when the shape changed. It sat above a value that had
 * silently become wrong. An argument whose premise can quietly expire should say
 * which premise, plainly, so the next reader can check it in one glance. This one
 * does: **the number below is defensible only while `triagePanes` builds one
 * full-width row over another.** If the collator ever shares its row again, this
 * goes back to `null`.
 *
 * ## Why one third rather than a half
 *
 * `new-split` halves, so the shape that arrives is 50/50 and the correction is a
 * shrink. The rows are genuinely UNLIKE, which is {@link OPERATIONS_TOP_FRACTION}'s
 * situation rather than {@link REVIEW_TOP_FRACTION}'s: the collator holds ONE
 * document — the sweep it composed and the collation it wrote back — while the
 * row beneath holds three independent observers working three slices at once.
 * Three panes of live work want the room; one pane of settled output does not.
 *
 * A shrink is also the branch that already works. `applyTopFraction` chooses the
 * row by the SIGN of the correction, so a target below the current height
 * addresses the BOTTOM row with `-U`, which is a border those panes really have.
 * Measured on the live console 2026-09-13: container 1052px, top row 526px, so
 * the target of 350.67px makes `growTop` false and the three observer panes each
 * ask to grow to 701.33px. They share ONE divider, so the re-read-before-every-pane
 * rule collapses the second and third asks to sub-pixel no-ops — the behaviour
 * that docblock's 2026-09-03 measurement describes, reached here for the first
 * time by a console other than `operations`.
 *
 * ## And the old caveat that still stands: nobody is watching
 *
 * Height is a claim about where an eye should go first, and on the ordinary path
 * there is no eye — this console runs on a clock with no keyboard in any seat.
 * The moment it IS read is after something has gone wrong. That argued for
 * declining to pre-commit while the panes were interchangeable; it does not argue
 * against this value, because the asymmetry being expressed is not about interest
 * but about CONTENT — three panes doing three things need more room than one pane
 * holding one document, whoever is or is not looking at them.
 */
export const TRIAGE_TOP_FRACTION: number | null = 1 / 3;

/**
 * How much of the container's WIDTH each pane in the observer row gets.
 *
 * ## Why this constant exists when no sibling console has one
 *
 * `new-split` halves. Every console before this one was a 2x2, so two columns
 * each split once were already equal and nothing ever had to ask. A row of
 * THREE cannot be reached that way at any depth — halving produces powers of
 * two — so the observer row comes out of the builder at **50/25/25** and stays
 * there unless something corrects it.
 *
 * MEASURED on the live console 2026-09-13, before any correction: a 795.33px
 * container holding `obs-t1` at 397.67, `obs-t2` at 198.83 and `obs-t3` at
 * 198.83. Exactly one half and two quarters, which is what a `right` split
 * chain always gives — each split halves only what the previous pane held.
 *
 * ## Why that is a defect rather than a preference
 *
 * The three observers are handed EVEN shares of the environment
 * (`roles/triage.md` asks for the split to be even, and `evenSlices` makes it
 * so). A row that renders one of them at twice the width of the other two says
 * the opposite — it reads as a lead observer and two helpers, which is not the
 * arrangement and not what the collator briefed. The layout is the only part of
 * this console an operator sees before reading anything, so a shape that
 * misdescribes the work is worse here than on a console somebody is typing in.
 *
 * ## `1/3` rather than a list of three
 *
 * One fraction applied per pane, not a per-pane table, because the requirement
 * is EQUALITY rather than a chosen distribution — a table would be three
 * numbers that must be kept summing to one, and the first edit that added a
 * fourth observer would leave it summing to more. A single fraction with N
 * panes is the same statement and cannot drift out of range.
 */
export const TRIAGE_OBSERVER_WIDTH_FRACTION: number | null = 1 / 3;

/**
 * The triage console's panes, in creation order.
 *
 * `DEFAULT_TRIAGE_WORKERS` still holds four ids — Phase 2.1 of
 * `Docs/SRD-TRIAGE-MIXED-OBSERVERS.md` moves it to seven — so this function
 * branches on the WORKER COUNT it is actually handed, rather than assuming a
 * single shape:
 *
 *  - **Four** workers still delegate to {@link collatorOverRowPanes}, the
 *    builder SHARED with {@link reviewPanes}: one collator across the top,
 *    its workers in one row beneath. Phase 2.1 deletes this branch once
 *    `DEFAULT_TRIAGE_WORKERS` moves to seven and every call takes the table
 *    below instead.
 *  - **Seven** workers build from a HARDCODED table
 *    (SRD-TRIAGE-MIXED-OBSERVERS §4.2), never `collatorOverRowPanes` and never
 *    a computed sequence — the collator full width, TWO full-width rows of
 *    three beneath it:
 *
 *        +-----------------------------------+
 *        |                 0                 |
 *        +----------+-----------+------------+
 *        |    1     |     3     |     4      |
 *        +----------+-----------+------------+
 *        |    2     |     5     |     6      |
 *        +----------+-----------+------------+
 *
 *    CREATION order is not READING order. A full-width row can only be
 *    peeled off a pane BEFORE the row above it is divided into columns — once
 *    a pane has been split `right`, a later `down` off it only narrows that
 *    one cell, not the whole row. So both `down` splits that open the two
 *    observer rows (indices 1 and 2) happen before either row's own `right`
 *    splits (3 and 4 on row one; 5 and 6 on row two), even though the rows
 *    read out left to right as `1, 3, 4` and `2, 5, 6`.
 *  - **Any other count** — 0 gets its own message; 1, 2, 3, 5, 6, 8 and up do
 *    not — is refused by name: the console holds exactly four or seven
 *    workers and has no sensible degraded shape in between or beyond them.
 *
 * Panes are built the way {@link collatorOverRowPanes} builds one (same
 * `title`/`worker`/`command` shape, same `backend`/`configPath` defaults, same
 * `assertPlainValue` checks) so the seven-pane branch differs from the
 * four-pane one only in geometry, not in how a pane is assembled.
 */
export function triagePanes(opts: OperationsPlanOptions): OperationsPane[] {
  const workers = opts.workers ?? DEFAULT_TRIAGE_WORKERS;

  if (workers.length === 0) {
    throw new Error("triage: refusing an empty --workers set — name at least one worker");
  }

  if (workers.length === 4) {
    // Phase 2.1 of Docs/SRD-TRIAGE-MIXED-OBSERVERS.md removes this branch
    // once DEFAULT_TRIAGE_WORKERS moves to seven and every call falls through
    // to the seven-pane table below.
    return collatorOverRowPanes(opts, DEFAULT_TRIAGE_WORKERS, "triage");
  }

  if (workers.length !== 7) {
    throw new Error(
      `triage: refusing ${workers.length} workers — the console holds exactly four workers ` +
        `(one collator, one row of three) or seven (one collator, two rows of three)`,
    );
  }

  const repoRoot = opts.repoRoot;
  const backend = opts.backend ?? "headless";
  const configPath = opts.configPath ?? `${repoRoot}/fleet.yaml`;

  for (const w of workers) assertPlainValue("worker id", w);
  assertPlainValue("backend", backend);

  const tuiWorkers = new Set(opts.tuiWorkers ?? []);

  // SRD-TRIAGE-MIXED-OBSERVERS §4.2's own table, kept beside the docblock's
  // diagram deliberately — the two have to agree, and cannot if the sequence
  // is computed. Index 0 takes the initial surface (`split: null`) and is
  // read straight off this table for i >= 1; the anchor discipline (which
  // pane a split names as `splitFrom`) is the part that breaks under a
  // "same as the previous one" assumption once a row divides.
  const SEVEN_PANE_SHAPE: readonly { split: SplitDirection; splitFrom: number }[] = [
    { split: "down", splitFrom: 0 },
    { split: "down", splitFrom: 1 },
    { split: "right", splitFrom: 1 },
    { split: "right", splitFrom: 3 },
    { split: "right", splitFrom: 2 },
    { split: "right", splitFrom: 5 },
  ];

  return workers.map((worker, i) => ({
    title: worker,
    worker,
    command: `${envPreamble()} ${agentPaneCommand({
      repoRoot,
      worker,
      backend,
      configPath,
      attach: tuiWorkers.has(worker),
      workspaceName: opts.workspaceName,
    })}`,
    ...(i === 0 ? { split: null } : SEVEN_PANE_SHAPE[i - 1]!),
  }));
}
