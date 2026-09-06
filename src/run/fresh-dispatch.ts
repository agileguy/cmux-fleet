/**
 * The two orderings a console's `--restart` is made of, and the injected side
 * effects that make both of them testable.
 *
 * {@link recreateThenDispatch} is `--restart <worker> --task <file>`: wait,
 * stop, respawn, dispatch. {@link resolveThenRestart} is the bare
 * `--restart <worker>`: resolve the pane, stop, respawn. They are siblings on
 * purpose — the same four side effects, the same convention for injecting
 * them, the same suite re-checking the order — because the SECOND of them was
 * once written inline in three scripts and got the order right in none of them
 * for the same reason twice.
 *
 * A note on a claim this module falsifies, because it was written down and
 * believed: `ISA.md` said the stop-then-respawn ordering *"could not be moved
 * into a module because the stop is the script's to do"*. It is the script's to
 * DO and it was never the script's to ORDER, and `recreateThenDispatch` had
 * already been demonstrating the difference for the `--task` half of the very
 * same branch. Two independent reviewers said so; the bare half now gets the
 * same treatment, and what stays in the scripts is `Bun.spawn`, `process.stderr`
 * and a cmux client.
 *
 * ## Why a dispatch would want a new worker at all — RECREATE FIRST, DISPATCH SECOND
 *
 * A `pane_mode: tui` worker keeps its session across epochs. Measured
 * 2026-09-04: `T-unit-tests-3` was staged to `tst-1`, the worker was
 * auto-triggered, and it answered about `T-unit-tests-2` — the PREVIOUS task —
 * reciting that envelope's contents without opening the new one. The transcript
 * had the old task in it, and the cheapest thing a model can do with a vague
 * "a task was staged for you" is answer from what it already holds. The run
 * settled `success` seven seconds after staging.
 *
 * A worker that has never seen another task cannot do that. So the fix
 * available here is not a better trigger but a fresh session: recreate first,
 * dispatch second.
 *
 * ## The rule this module exists to enforce
 *
 * **NOTHING IS RECREATED WHILE THE WORKER STILL HOLDS WORK.** Recreating a busy
 * worker destroys a running task — its container, its supervisor and its
 * uncommitted worktree all go — and it does so at the one moment the operator
 * is least able to notice, because the replacement looks identical to a healthy
 * worker seconds later. {@link settledEnough} is therefore consulted BEFORE any
 * teardown, the wait is bounded, and a timeout REFUSES rather than proceeding.
 * There is no force flag here on purpose: "wait longer" and "abort the task"
 * are both things the operator can say, and neither should be inferred from a
 * dispatch.
 *
 * A STAGED task counts as work. It is the case that looks idle and is not:
 * `phase` reads `idle` and `task_id` is null while `staged_task_id` names an
 * envelope the worker has accepted and not yet run. That is exactly the state
 * `T-unit-tests-3` sat in, and treating it as settled would recreate the worker
 * over a task the operator had already handed it, silently.
 *
 * ## Why the dependencies are injected
 *
 * Everything below is orchestration over a handful of side effects — resolve a
 * pane, read status, stop a run, respawn a pane, quiesce a relay, dispatch.
 * Injecting them keeps the ORDER and the REFUSALS testable with no cmux, no
 * containers, no relay and no clock, which is the only way the "never while
 * busy" and "refuse before destroying" rules get re-checked on every run rather
 * than being sentences in a docblock.
 */

import { runsHoldingAny } from "./status-runs.ts";

/** What `status --all --json` says about one worker right now. */
export interface WorkerActivity {
  readonly runId: string;
  readonly phase: string;
  readonly taskId: string | null;
  readonly stagedTaskId: string | null;
  readonly alive: boolean;
}

interface StatusDoc {
  readonly runs?: ReadonlyArray<{
    readonly run_id?: unknown;
    readonly workers?: ReadonlyArray<Record<string, unknown>>;
  }>;
}

/**
 * Every run that currently reports `worker`, in the order status listed them.
 *
 * A LIST rather than one entry, because a worker appearing in two runs is a
 * real state — a console rebuilt while an old supervisor lingered — and the
 * busy check has to consider all of them. Collapsing to the first would let a
 * task running in the second run be recreated out from under.
 */
export function workerActivity(statusJson: string, worker: string): WorkerActivity[] {
  let doc: StatusDoc;
  try {
    doc = JSON.parse(statusJson) as StatusDoc;
  } catch {
    /*
     * Unreadable status is NOT "no activity". `runsHoldingAny` may return the
     * empty list on bad JSON because stopping nothing is its safe direction;
     * here the safe direction is the opposite, and returning "not busy" would
     * green-light a teardown on no evidence. The caller distinguishes the two
     * by asking whether status parsed at all.
     */
    throw new Error("could not read `status --all --json`, so the worker's state is unknown");
  }
  if (!Array.isArray(doc?.runs)) {
    throw new Error("`status --all --json` carried no runs array");
  }
  const out: WorkerActivity[] = [];
  for (const run of doc.runs) {
    const runId = run?.run_id;
    if (typeof runId !== "string" || runId === "") continue;
    const workers = Array.isArray(run.workers) ? run.workers : [];
    for (const w of workers) {
      if (w?.["id"] !== worker) continue;
      const phase = w["phase"];
      const taskId = w["task_id"];
      const staged = w["staged_task_id"];
      out.push({
        runId,
        phase: typeof phase === "string" ? phase : "unknown",
        taskId: typeof taskId === "string" ? taskId : null,
        stagedTaskId: typeof staged === "string" ? staged : null,
        alive: w["alive"] === true,
      });
    }
  }
  return out;
}

/**
 * Is there no work left in this entry?
 *
 * `phase` alone is not enough and `task_id` alone is not enough — see the
 * module docblock on the staged case. An UNKNOWN phase is treated as busy: a
 * status shape this does not recognise is not evidence that a worker is free.
 */
export function settledEnough(a: WorkerActivity): boolean {
  if (a.taskId !== null) return false;
  if (a.stagedTaskId !== null) return false;
  return a.phase === "idle";
}

/** Why a recreate was refused, in the words the operator needs. */
export function busyRefusal(worker: string, busy: readonly WorkerActivity[]): string {
  const what = busy
    .map((b) => {
      const held = b.taskId ?? b.stagedTaskId;
      const kind = b.taskId !== null ? "running" : "staged";
      return held === null
        ? `run ${b.runId} reports phase '${b.phase}'`
        : `run ${b.runId} is ${kind} ${held}`;
    })
    .join("; ");
  return (
    `${worker} still holds work (${what}), and a recreate would destroy it. ` +
    `Nothing has been stopped. Wait for it to finish, or end it yourself with ` +
    `\`pifleet abort --worker ${worker}\` (running) or \`pifleet unstage --worker ${worker}\` (staged).`
  );
}

/** The side effects {@link recreateThenDispatch} needs, so its order is testable. */
export interface FreshDispatchDeps {
  /** stdout of `pifleet status --all --json`. */
  readonly status: () => Promise<string>;
  /** `pifleet down --run <id>`. */
  readonly down: (runId: string) => Promise<void>;
  /** Respawn the worker's console pane, which re-runs its `up`. */
  readonly restartPane: () => Promise<void>;
  /** `pifleet dispatch --worker <w> --run <runId> --task <file>`; returns stdout. */
  readonly dispatch: (runId: string) => Promise<string>;
  readonly sleep: (ms: number) => Promise<void>;
  readonly now: () => number;
}

export interface FreshDispatchOptions {
  readonly worker: string;
  /** How long to let a running or staged task finish. Default 20 minutes. */
  readonly settleTimeoutMs?: number;
  /** How long to wait for the recreated worker to report in. Default 3 minutes. */
  readonly readyTimeoutMs?: number;
  readonly pollMs?: number;
}

export interface FreshDispatchResult {
  /** Milliseconds spent waiting for the worker's previous task to finish. */
  readonly settleWaitMs: number;
  /** The runs that were stopped. */
  readonly stopped: readonly string[];
  /** The run the recreated worker came up in. */
  readonly runId: string;
  /** `dispatch`'s stdout. */
  readonly dispatched: string;
}

const DEFAULT_SETTLE_MS = 20 * 60_000;
const DEFAULT_READY_MS = 3 * 60_000;
const DEFAULT_POLL_MS = 3_000;

/**
 * Wait for `worker` to be holding nothing, then recreate it, then dispatch.
 *
 * Throws — having stopped nothing — if the worker does not settle in time.
 */
export async function recreateThenDispatch(
  deps: FreshDispatchDeps,
  opts: FreshDispatchOptions,
): Promise<FreshDispatchResult> {
  const settleTimeout = opts.settleTimeoutMs ?? DEFAULT_SETTLE_MS;
  const readyTimeout = opts.readyTimeoutMs ?? DEFAULT_READY_MS;
  const poll = opts.pollMs ?? DEFAULT_POLL_MS;
  const started = deps.now();

  /*
   * PHASE 1 — wait it out. No teardown of any kind happens above this line,
   * so a refusal here leaves the fleet exactly as it was found.
   */
  let statusJson = await deps.status();
  let busy = workerActivity(statusJson, opts.worker).filter((a) => !settledEnough(a));
  while (busy.length > 0) {
    if (deps.now() - started >= settleTimeout) {
      throw new Error(busyRefusal(opts.worker, busy));
    }
    await deps.sleep(poll);
    statusJson = await deps.status();
    busy = workerActivity(statusJson, opts.worker).filter((a) => !settledEnough(a));
  }
  const settleWaitMs = deps.now() - started;

  // PHASE 2 — the runs to replace, named from the SETTLED status read.
  const previous = runsHoldingAny(statusJson, new Set([opts.worker]));
  for (const runId of previous) await deps.down(runId);

  // PHASE 3 — respawn, then wait for a run that is not one of the old ones.
  await deps.restartPane();
  const readyBy = deps.now() + readyTimeout;
  let fresh: WorkerActivity | undefined;
  for (;;) {
    await deps.sleep(poll);
    let seen: WorkerActivity[] = [];
    try {
      seen = workerActivity(await deps.status(), opts.worker);
    } catch {
      // A status read that fails mid-restart is expected — the registry is
      // being rewritten. Keep waiting; the deadline below is the bound.
      seen = [];
    }
    /*
     * NEW run, and ALIVE. Requiring the id to differ is what stops this
     * dispatching into the corpse of the run just stopped, whose directory
     * outlives its supervisor; requiring `alive` is what stops it racing the
     * supervisor that has registered but not yet finished coming up.
     */
    fresh = seen.find((a) => !previous.includes(a.runId) && a.alive);
    if (fresh !== undefined) break;
    if (deps.now() >= readyBy) {
      throw new Error(
        `${opts.worker} did not come back within ${Math.round(readyTimeout / 1000)}s of being ` +
          `recreated, so nothing was dispatched. Its pane holds the reason — a missing image is ` +
          `the usual one, and \`pifleet image build\` names the toolchain.`,
      );
    }
  }

  /*
   * PHASE 4 — dispatch, AND CHECK THAT IT LANDED.
   *
   * **MEASURED, and the reason this is not just `await deps.dispatch(...)`.**
   * `scripts/review` wires this dep to a helper whose own docblock says it runs
   * a subcommand "swallowing failure", with `stderr: "ignore"` so the reason is
   * discarded too. A task envelope this function never sees was refused by the
   * validator, `dispatch` exited 2, the helper returned `""`, and the console
   * printed *"recreated col-1 into run <id> ... and dispatched <path>"* and
   * exited 0. Nothing was in the inbox. The operator waited for a review that
   * could never run.
   *
   * The check belongs HERE rather than in the wrapper for the reason the relay's
   * own dispatch path already records one layer up: *"`accepted` alone does not
   * answer whether it actually happened"* — and neither does a caller's choice
   * of subprocess helper. This function's whole promise is *recreate, then
   * dispatch*; returning a payload it never inspects makes the second half a
   * hope. Any caller wiring any runner now gets the same guarantee.
   *
   * The refusal names what was ALREADY DONE, because by this line the previous
   * runs are stopped and the pane has been respawned. A message that said only
   * "dispatch failed" would leave an operator guessing whether the fleet had
   * been touched.
   */
  const dispatched = await deps.dispatch(fresh.runId);
  const problem = dispatchProblem(dispatched);
  if (problem !== null) {
    throw new Error(
      `${opts.worker} was recreated into run ${fresh.runId} and the dispatch DID NOT LAND: ` +
        `${problem}. The worker is up and holding nothing; re-run the dispatch once the task ` +
        `envelope is fixed, or run this script again with the same --task.`,
    );
  }

  return {
    settleWaitMs,
    stopped: previous,
    runId: fresh.runId,
    dispatched,
  };
}

/**
 * Why `dispatch`'s stdout does not show a task that landed, or `null`.
 *
 * Three failures, and each one is a real observation rather than a defensive
 * arm. **Empty** is what a runner that swallows a non-zero exit returns, which
 * is the measured case. **Unparseable** is what `--json` cannot produce and a
 * runner that merged stderr into stdout can. **`accepted: false`** is the
 * supervisor's own refusal — a stale epoch, a worker already holding the id —
 * which exits 0 and is the one a status check would miss entirely.
 *
 * Deliberately tolerant about everything else in the payload: this asks whether
 * the task landed, and `dispatch`'s schema is not this module's to police.
 */
function dispatchProblem(stdout: string): string | null {
  const text = stdout.trim();
  if (text === "") {
    return "it produced no output at all, which is what a runner that discards a failing exit status returns";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `its output is not the JSON --json promises: ${text.slice(0, 200)}`;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return `its output is JSON but not an object: ${text.slice(0, 200)}`;
  }
  const accepted = (parsed as { accepted?: unknown }).accepted;
  if (accepted !== true) {
    return `it was refused — accepted is ${JSON.stringify(accepted)}: ${text.slice(0, 200)}`;
  }
  return null;
}

/**
 * The side effects {@link resolveThenRestart} needs, so its ORDER is testable.
 *
 * `T` is whatever the respawn hands back — a surface id, a whole
 * `RestartResult`, anything a script wants to print. This module has no opinion
 * about it and deliberately no way to form one: typing it concretely would mean
 * importing `src/backends/cmux/`, and ISC-137 keeps every cmux import inside
 * that directory. What the module has an opinion about is WHEN the respawn
 * happens, which is the only thing it can get wrong.
 */
export interface ConsoleRestartDeps<T> {
  /**
   * Resolve the pane the console plans under this title — `plannedPane`, which
   * is PURE and THROWS when the console plans no such pane.
   *
   * Synchronous on purpose. Everything else in this interface is I/O and this
   * one is not, and the whole value of the phase below is that it can refuse
   * having touched nothing. A dep typed `Promise` would invite a caller to put
   * a cmux call here, and a cmux call is a thing that can fail for reasons that
   * have nothing to do with whether the title is plannable.
   */
  readonly plan: () => unknown;
  /** stdout of `pifleet status --all --json`. */
  readonly status: () => Promise<string>;
  /**
   * Stop the console's relay, or `null` for a console that has none.
   *
   * REQUIRED AND NULLABLE rather than optional, so each console states which it
   * is. `operations` and `development` have no fifth process; `review` does, and
   * a `review` that forgot to pass this would respawn a pane under a relay whose
   * run pins are fixed for the life of the process — see {@link resolveThenRestart}.
   * An omitted optional field and a console that genuinely has no relay look
   * identical at the call site; `null` and a missing property do not.
   */
  readonly quiesce: (() => Promise<void>) | null;
  /** `pifleet down --run <id>`. */
  readonly down: (runId: string) => Promise<void>;
  /** Respawn the worker's console pane, which re-runs its `up`. */
  readonly restartPane: () => Promise<T>;
}

export interface ConsoleRestartOptions {
  /** The worker whose runs are stopped. Also the pane title, on the consoles where those agree. */
  readonly worker: string;
}

export interface ConsoleRestartResult<T> {
  /** The runs that were stopped, in the order status listed them. */
  readonly stopped: readonly string[];
  /** Whatever `restartPane` returned. */
  readonly pane: T;
}

/**
 * Resolve the pane, THEN stop the runs holding the worker, THEN respawn it.
 *
 * The bare `--restart <worker>` of all three console scripts, in one place,
 * because all three had it inline and the ordering below is three separate
 * measurements deep.
 *
 * ## PHASE 1 — RESOLVE BEFORE DESTROYING
 *
 * MEASURED 2026-09-06. `./scripts/operations --restart obs-1` printed, in this
 * order:
 *
 *     operations: stopping run 2026-09-04T18-03-52Z-e2fc before restarting obs-1
 *     operations: 'obs-1' is not a pane this console plans — it holds observer, monitor, ticketing
 *
 * Both operations workers were left DOWN with nothing respawned. The refusal was
 * already correct and already tested; it arrived after the only irreversible
 * step, because the teardown keys on WORKER ID (`runsHoldingAny`) and the
 * respawn keys on PANE TITLE (the plan), and on that console those namespaces
 * are disjoint — the panes are `observer` and `ticketing`, the workers `obs-1`
 * and `tick-1`. The instance is narrow and the shape is not: any live worker id
 * a console does not plan reaches it, `development` and `review` included.
 *
 * So `plan` runs FIRST and nothing in this function precedes it. A throw here
 * leaves the fleet exactly as it was found.
 *
 * ## PHASE 2 — THE RELAY GOES DOWN BEFORE THE RUNS DO, AND NEVER ON A REFUSAL
 *
 * `scripts/review` runs a fifth process whose whole configuration is run ids:
 * `--run <id>` for the collator and a `PIFLEET_RELAY_RUNS` pin for the other
 * three, both fixed for the life of the process. Respawning ANY pane invalidates
 * them, and a relay left pointing at a dead run polls forever in silence. It is
 * therefore stopped before the teardown rather than merely before the respawn.
 *
 * And it is stopped AFTER `plan`, which is the half a refusal gets wrong. On the
 * measured operations failure the console had no relay to lose; on `review` the
 * same mistyped title would have taken the actor down as well, leaving three
 * healthy reviewers, a collator, and nothing able to turn a dispatch request
 * into reviews.
 *
 * ## PHASE 3 THEN 4 — STOP THE RUN, THEN RESPAWN THE PANE
 *
 * Never the other way round, and this is the older of the two lessons.
 * Respawning first kills the pane's shell, and the supervisor that shell
 * launched — which owns a detached container — is signalled by the dying shell
 * rather than told to quiesce. The container outlives every record of it. See
 * `restartConsolePane`, whose contract makes the same statement from the other
 * side: *"the caller is responsible for stopping any run the worker still holds
 * BEFORE calling this."* This function IS that caller now, so the contract has
 * one reader rather than three.
 *
 * The teardown is scoped to runs actually holding `worker`, so restarting a
 * watch pane — `fleet-status`, `git-watch`, the monitor — stops nothing and
 * simply respawns it. An unreadable status stops nothing either, which is
 * `runsHoldingAny`'s own documented direction and the right blast radius for a
 * launcher: containers left running are untidy, and a console that refuses to
 * come back is not.
 */
export async function resolveThenRestart<T>(
  deps: ConsoleRestartDeps<T>,
  opts: ConsoleRestartOptions,
): Promise<ConsoleRestartResult<T>> {
  // PHASE 1. Nothing above this line and nothing irreversible in it.
  deps.plan();

  // PHASE 2.
  if (deps.quiesce !== null) await deps.quiesce();

  // PHASE 3.
  const stopped = runsHoldingAny(await deps.status(), new Set([opts.worker]));
  for (const runId of stopped) await deps.down(runId);

  // PHASE 4.
  const pane = await deps.restartPane();
  return { stopped, pane };
}
