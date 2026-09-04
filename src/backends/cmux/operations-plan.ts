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
 * ## Three host facts this file is shaped by, each measured on 2026-08-30
 *
 * - **`pifleet` is not on `PATH`.** `package.json` is `private: true` and its
 *   `bin` entry is never linked, so `which pifleet` finds nothing. Every pane
 *   therefore invokes the CLI as `bun run <repo>/src/cli/index.ts`, by ABSOLUTE
 *   path, so the pane keeps working if its cwd is ever somewhere else.
 * - **`watch(1)` does not exist on this host.** It is a Linux/procps tool, and
 *   macOS does not ship it. The git pane is a `while` loop for that reason and
 *   must stay one; a `watch` line would fail on the first tick with
 *   `command not found` and leave a dead pane that looks configured.
 * - **`--command` text is shell-INJECTED, not exec'd** (SRD §4.1) — cmux types
 *   it into the pane's shell. So interpolating a path directly is command
 *   injection by construction, and every interpolated value below goes through
 *   `shellQuote`.
 */

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
 * the pane a human actually watches, and `observer` is the role whose work
 * is worth watching in real time — a deploy being followed through a pipeline,
 * or a service being interrogated. `tick-1`, the previous default, does its
 * work in one burst and then has nothing to show.
 *
 * `obs-1` specifically, NOT the `observer` role: the role resolves to
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
export function pifleetCommand(repoRoot: string, argv: readonly string[]): string {
  return `bun run ${shellQuote([`${repoRoot}/src/cli/index.ts`, ...argv])}`;
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
}): string {
  const { repoRoot, worker, backend, configPath, attach } = args;
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
    agentPaneCommand({ repoRoot, worker, backend, configPath, attach: tuiWorkers.has(worker) });

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
      command: `${monitorPaneCommand(repoRoot, poll)}; exec $SHELL -i`,
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
 * |     tst-1     |     rev-1     |
 * +---------------+---------------+
 * ```
 *
 * Two engineers on top because that is the pair a person actually alternates
 * between — two changes in flight, each with its own container and its own
 * branch. The tester and the reviewer sit under them because their work is
 * downstream of it and is read in bursts rather than watched.
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
  "rev-1",
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
 * A 2x2 of attended agent panes — the shape BOTH `development` and `review`
 * are, built once.
 *
 * Extracted when the second such console arrived, and the extraction is not
 * tidiness. The split TABLE below is the part that breaks: a 2x2 cannot be
 * built from "always split the previous pane", pane 4 has to name pane 2 as its
 * anchor, and `operationsPanes` already learned that lesson separately at its
 * git pane. A copied table is a second place to get that backwards, and the two
 * copies would be identical on the day they were written and only diverge
 * afterwards — which is exactly the drift the Dockerfile's `toolchain-full`
 * stage was carrying when it was folded into its siblings.
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
    command: `${envPreamble()} ${agentPaneCommand({
      repoRoot,
      worker,
      backend,
      configPath,
      attach: tuiWorkers.has(worker),
    })}`,
    ...(i === 0 ? { split: null } : shape[i - 1]!),
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
export function envPreamble(): string {
  return `set -a; [ -f "$HOME/.env" ] && . "$HOME/.env"; set +a;`;
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
 * +---------------+---------------+
 * |     col-1     |   rev-arch-1  |
 * +---------------+---------------+
 * |   rev-ctx-1   |   rev-lang-1  |
 * +---------------+---------------+
 * ```
 *
 * THE COLLATOR IS PANE 1, and that placement is the contract rather than a
 * preference: pane 1 consumes the workspace's initial surface and is where the
 * operator lands. This console is driven by talking to the collator — it writes
 * the three briefs and reads the three reports back — so the seat the keyboard
 * arrives in is the one seat a person actually types into.
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
 * The review console's panes are EQUAL, and `null` says so.
 *
 * Same reasoning as {@link DEVELOPMENT_TOP_FRACTION}, and the stated
 * requirement here is stronger: this console was asked for as "four equally
 * sized panes in a square". `new-split` halves, so two columns each split once
 * are already four quarters, and `null` skips the resize rather than asking for
 * a fraction of `1/2` and relying on the sub-pixel guard to make it a no-op.
 *
 * There is also nothing to favour. The collator has three reports to show and
 * each reviewer has one; that is not a difference in HEIGHT, it is a difference
 * in how often you scroll.
 */
export const REVIEW_TOP_FRACTION: number | null = null;

/**
 * The review console's panes, in creation order.
 *
 * The same 2x2 as {@link developmentPanes} and built by the same function —
 * see {@link agentSquarePanes} for why the split table is shared rather than
 * copied. Only the default worker set and the name in a refusal differ.
 */
export function reviewPanes(opts: OperationsPlanOptions): OperationsPane[] {
  return agentSquarePanes(opts, DEFAULT_REVIEW_WORKERS, "review");
}
