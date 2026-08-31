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
 * | 1 | `ticketing` | `pifleet up --workers tick-1`, then an interactive shell |
 * | 2 | `fleet-status` | `pifleet status --watch` |
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
 * `tick-1` is `fleet.yaml`'s ticketing worker. This is a LIST rather than a
 * single id because `up --workers` already takes a set (ISC-61) and the
 * operations console has no business being narrower than the command it drives
 * — naming two workers here is a config edit, not a code change.
 */
export const DEFAULT_OPERATIONS_WORKERS: readonly string[] = ["tick-1"];

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

  const up = pifleetCommand(repoRoot, [
    "up",
    "--workers",
    workers.join(","),
    "--backend",
    backend,
    "--config",
    configPath,
  ]);
  const status = pifleetCommand(repoRoot, ["status", "--watch"]);

  return [
    {
      title: "ticketing",
      // `;` and not `&&`: a failed `up` must still leave a usable shell. With
      // `&&` a fleet that refuses admission closes the pane, taking the error
      // message with it, and the operator is left with a workspace that has a
      // hole where its console was. Measured on the first live run, where `up`
      // did refuse and the shell was what made the refusal readable.
      command: `${envPreamble()} ${up} ; exec $SHELL -i`,
      // The initial surface: the whole workspace until something splits it.
      split: null,
    },
    {
      title: "fleet-status",
      command: status,
      // DOWN off pane 1, which is what makes ticketing the top HALF rather
      // than a column: the first split decides the major axis, and everything
      // after it lands inside the half this one created.
      split: "down",
    },
    {
      title: "git-watch",
      // `git -C <dir>` rather than a `cd`: the loop reports on the invocation
      // directory no matter where the pane's shell started, so a workspace cwd
      // that failed to apply cannot silently redirect the pane at something
      // else. `watchDir`, never `repoRoot` — see the field's docblock.
      command: gitWatchCommand(watchDir, poll),
      // RIGHT off fleet-status, so the two lower panes tile side by side in the
      // bottom half. Splitting right off pane 1 instead would put git-watch in
      // the top row beside ticketing, which is the layout this replaced.
      split: "right",
    },
  ];
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
 * The git pane's poll loop.
 *
 * Separate and exported so the "no `watch(1)`" rule has something to assert
 * against directly. `clear` at the top of each tick rather than at the bottom:
 * a loop that clears after printing leaves a blank pane between ticks, which
 * reads as a hung console.
 */
export function gitWatchCommand(watchDir: string, pollSeconds: number): string {
  // `--no-pager` IS THE WHOLE PANE. Measured on the first live run: `git log`
  // found a terminal on stdout, started `less`, and the loop stopped at `(END)`
  // waiting for a keypress that was never coming. The pane showed a plausible
  // commit list, refreshed never, and looked like a working watch — the exact
  // failure a screenshot cannot distinguish from success. `git -c core.pager=`
  // and `GIT_PAGER=cat` both work too; this is the shortest, and it survives a
  // user's `[pager]` config, which an unset environment variable does not.
  const g = `git --no-pager -C ${shellQuote([watchDir])}`;
  return (
    `while :; do clear; ${g} status --short --branch; echo; ` +
    `${g} log --oneline -10; sleep ${pollSeconds}; done`
  );
}
