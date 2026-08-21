/**
 * The reaper (ISC-118, SRD §13.1, F31): the daemon's answer to a wedged
 * supervisor — the process nothing else can kill, because the supervisor IS
 * the thing that kills everything else.
 *
 * Detection is heartbeat staleness, and the staleness arithmetic is the
 * subtle part. `heartbeat_at` in state.json is a wall-clock LABEL written by
 * another process; subtracting it from this process's wall clock is exactly
 * the computation ISC-155 forbids, and with reason — a suspended laptop would
 * wake to find every supervisor "stale" at once and reap the whole healthy
 * fleet. So the daemon never subtracts wall timestamps. It watches the label
 * for CHANGE: a `Stopwatch` on the daemon's own monotonic clock restarts each
 * time a worker's `heartbeat_at` differs from the last value observed, and
 * staleness is that stopwatch's reading (ISC-146). A label that keeps moving
 * is a live supervisor whatever the clocks disagree about; a label frozen for
 * 3× `heartbeat_interval` is a dead or wedged one.
 *
 * Reaping is the kill ladder from safety/kill.ts minus the abort rung — a
 * wedged supervisor has no working RPC to answer an abort on — addressed to
 * the supervisor's process GROUP: SIGTERM ⇒ grace ⇒ SIGKILL, then
 * `docker rm -f` on the worker's container, which the supervisor can no
 * longer stop itself. Every signal is guarded by the recorded `(pid,
 * started)` identity (ISC-191): a reboot or crash recycles pids, and the
 * registry entry for a supervisor that died with the old boot must never
 * become a signal aimed at whoever holds that number now.
 *
 * Idempotent by construction: reaping something already gone is `already_gone`
 * and a no-op — the daemon's scan loop will routinely race supervisors' own
 * clean exits, and losing that race must not be an error (ISC-118).
 *
 * A REAP THAT STOPPED NOTHING REMOVES NOTHING, and that rule is newer than the
 * rest of this file. The ladder has two outcomes that mean the supervisor is
 * STILL RUNNING: `group_unconfirmed` (it is alive and was deliberately not
 * signalled, because the group it recorded could not be shown to be its own —
 * ISC-272) and `unconfirmed` (it outlived the whole climb). Neither is a stop,
 * so neither may be followed by `docker rm -f`. `down` already stated the rule
 * for its own refusals — "killing its container out from under it would be
 * doing by the back door exactly what the refusal declined to do at the front"
 * — and `contracts.ts` states it as universal; it was true in `down` and false
 * here. The measured consequence: a supervisor that is not its own group leader
 * goes stale while alive, `confirmGroup` returns `not_led`, NOTHING is
 * signalled, and the reaper then removed its live container mid-write, the
 * daemon deleted its registry entry and `monitor.forget` dropped its staleness
 * clock. It survived as an orphan holding a worktree no process on the host
 * still named, and the ledger recorded it as reaped.
 *
 * So an un-stopped supervisor keeps its container, keeps its registry entry
 * (see `registry.ts`'s `deregisterOnReap`) and keeps its clock, which is what
 * makes the NEXT scan try again instead of losing sight of it forever.
 * `already_gone` is deliberately on the other side of that line: it means the
 * recorded identity is not there, so the container it left behind is exactly
 * F25's orphan and removing it is the whole point.
 */

import type { WorkerState } from "../contracts.ts";
import type { Registry } from "../run/registry.ts";
import {
  runKillLadder,
  realProcessOps,
  type KillOutcome,
  type ProcessOps,
} from "./kill.ts";
import { monotonicMs, Stopwatch } from "../util/clock.ts";

/** §13.1: a heartbeat older than 3× the interval means wedged. */
export const STALE_HEARTBEAT_MULTIPLIER = 3;

// ---------------------------------------------------------------------------
// Staleness — change detection on the daemon's own monotonic clock.
// ---------------------------------------------------------------------------

export class HeartbeatMonitor {
  readonly #now: () => number;
  readonly #seen = new Map<string, { label: string | null; sw: Stopwatch }>();

  constructor(now: () => number = monotonicMs) {
    this.#now = now;
  }

  /**
   * Record the currently visible `heartbeat_at` label for a worker. The
   * stopwatch restarts only when the label CHANGES; observing the same value
   * again is precisely the evidence of a stall and must not reset anything.
   */
  observe(worker: string, label: string | null): void {
    const prior = this.#seen.get(worker);
    if (prior === undefined) {
      this.#seen.set(worker, { label, sw: new Stopwatch(this.#now) });
      return;
    }
    if (prior.label !== label) {
      prior.label = label;
      prior.sw.restart();
    }
  }

  /**
   * Monotonic ms since this worker's label last changed. A worker never
   * observed reads 0 — a scan must observe before it judges, and a brand-new
   * worker gets a full window before it can possibly be called stale.
   */
  sinceChangeMs(worker: string): number {
    return this.#seen.get(worker)?.sw.elapsedMs() ?? 0;
  }

  /** Drop a reaped or deregistered worker so its entry cannot leak. */
  forget(worker: string): void {
    this.#seen.delete(worker);
  }
}

/** The §13.1 threshold, in one place so the multiplier cannot drift. */
export function isStale(sinceChangeMs: number, heartbeatIntervalMs: number): boolean {
  return sinceChangeMs > heartbeatIntervalMs * STALE_HEARTBEAT_MULTIPLIER;
}

// ---------------------------------------------------------------------------
// Reaping one supervisor
// ---------------------------------------------------------------------------

export interface ReapTarget {
  worker: string;
  /** Recorded identity of the supervisor — pid AND start time, never pid alone. */
  proc: { pid: number; started: string };
  /** Supervisor's process group; the child tree dies with it. */
  pgid: number | null;
  /** Container name to `docker rm -f` once the supervisor cannot object. */
  container: string | null;
}

export interface ReaperOps extends ProcessOps {
  /** `docker rm -f <name>`. Must resolve (not throw) on "no such container". */
  removeContainer(name: string): Promise<"removed" | "absent" | "failed">;
}

export const realReaperOps: ReaperOps = {
  ...realProcessOps,
  async removeContainer(name) {
    const proc = Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "pipe" });
    const stderr = await new Response(proc.stderr).text();
    await proc.exited;
    if (proc.exitCode === 0) return "removed";
    // Removing what is already gone is the idempotent case, not a failure.
    return /no such container/i.test(stderr) ? "absent" : "failed";
  },
};

export interface ReapReport {
  worker: string;
  supervisor: KillOutcome;
  /**
   * What became of the worker's container.
   *
   * `none` and `spared` are different facts and must not be collapsed: `none`
   * means the worker had no container to remove, `spared` means it had one and
   * the reaper deliberately left it running because the supervisor was not
   * stopped. Reporting the second as the first would describe the exact case
   * this module now refuses as if no container had ever existed.
   */
  container: "removed" | "absent" | "failed" | "none" | "spared";
}

/**
 * Whether a ladder outcome means the supervisor is no longer running.
 *
 * EXHAUSTIVE ON PURPOSE, with a `never`-typed default. The defect this replaces
 * was not a wrong branch, it was an ABSENT one: `group_unconfirmed` was added
 * to `KillOutcome` and every consumer that merely STORES the value kept
 * compiling, so the reaper went on removing containers on an outcome that means
 * "still alive, deliberately not signalled". A union member is invisible to
 * `tsc` for a consumer that does not switch on it. Switching on it here means a
 * seventh member breaks the build at the decision point instead of falling into
 * the destructive branch in silence.
 *
 * `already_gone` is TRUE. It is not a stop the reaper performed, but it is the
 * fact the caller needs: nothing holds the recorded identity, so whatever the
 * supervisor left behind is an orphan and cleaning it up is safe.
 */
function supervisorStopped(outcome: KillOutcome): boolean {
  switch (outcome) {
    case "aborted":
    case "terminated":
    case "killed":
    case "already_gone":
      return true;
    case "unconfirmed":
    case "group_unconfirmed":
    case "identity_unconfirmed":
      return false;
    default: {
      const unhandled: never = outcome;
      throw new Error(`unhandled KillOutcome: ${String(unhandled)}`);
    }
  }
}

export interface ReapOptions {
  ops?: ReaperOps;
  termGraceMs?: number;
  killGraceMs?: number;
  pollMs?: number;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/**
 * SIGTERM the group ⇒ grace ⇒ SIGKILL ⇒ remove the container, IF the ladder
 * stopped the supervisor.
 *
 * The container is removed even when the supervisor was `already_gone`: F25's
 * orphan is exactly a dead supervisor with a live container still burning
 * tokens, and skipping removal because the easier half of the cleanup was
 * done for us would leave the expensive half running.
 *
 * It is NOT removed when the ladder refused or failed to stop anything —
 * `group_unconfirmed` and `unconfirmed`. Both mean the supervisor is still
 * running, and it is running WITH that container: it holds the worktree, it is
 * mid-write, and `docker rm -f` would take it away from a live process. The
 * refusal declined to signal that supervisor precisely because it could not be
 * shown to be ours; destroying its container instead would be the same act
 * committed by another route. The gate is `supervisorStopped`, so a seventh
 * `KillOutcome` cannot land on the destructive side by omission.
 */
export async function reapSupervisor(
  target: ReapTarget,
  opts: ReapOptions = {},
): Promise<ReapReport> {
  const ops = opts.ops ?? realReaperOps;

  const supervisor = await runKillLadder({
    target: { pid: target.proc.pid, started: target.proc.started },
    pgid: target.pgid,
    abort: null, // wedged means the RPC is gone; there is nothing to ask.
    termGraceMs: opts.termGraceMs,
    killGraceMs: opts.killGraceMs,
    pollMs: opts.pollMs,
    ops,
    now: opts.now,
    sleep: opts.sleep,
  });

  let container: ReapReport["container"] = "none";
  if (target.container !== null) {
    container = supervisorStopped(supervisor)
      ? await ops.removeContainer(target.container)
      : "spared";
  }
  return { worker: target.worker, supervisor, container };
}

// ---------------------------------------------------------------------------
// One scan of the registry
// ---------------------------------------------------------------------------

export interface ReapCycleOpts extends ReapOptions {
  registry: Registry;
  /** Reads a worker's state.json; null when absent or unreadable. */
  readState: (worker: string) => Promise<WorkerState | null>;
  monitor: HeartbeatMonitor;
  heartbeatIntervalMs: number;
}

/**
 * Observe every registered worker's heartbeat and reap the stale ones.
 *
 * Returns every reap ATTEMPTED, including the ones that refused to stop
 * anything; observation is the side effect that arms the next cycle.
 * Deregistration is deliberately NOT done here — the registry has a single
 * writer and mutations go through its RPC verbs, so the daemon loop
 * deregisters from the reports this returns rather than this module growing a
 * second write path to registry.json. It deregisters a SUBSET of them, for the
 * reason `registry.ts`'s `deregisterOnReap` gives.
 *
 * THE CLOCK IS FORGOTTEN ONLY FOR A SUPERVISOR THAT IS ACTUALLY GONE.
 * `monitor.forget` exists so a reaped worker's stopwatch cannot leak, and for a
 * worker that really stopped there is nothing left to watch. A worker the
 * ladder REFUSED to stop is the opposite case: it is alive, it is still
 * registered, and dropping its stopwatch would reset its staleness to zero on
 * the next scan — so it would have to go stale all over again before anything
 * looked at it, every cycle, forever. Keeping the clock is what makes the
 * refusal a retry rather than an amnesia.
 */
export async function reapStale(opts: ReapCycleOpts): Promise<ReapReport[]> {
  const reports: ReapReport[] = [];
  for (const [name, entry] of Object.entries(opts.registry.workers)) {
    const state = await opts.readState(name);
    opts.monitor.observe(name, state?.heartbeat_at ?? null);
    if (!isStale(opts.monitor.sinceChangeMs(name), opts.heartbeatIntervalMs)) continue;

    const report = await reapSupervisor(
      {
        worker: name,
        proc: { pid: entry.pid, started: entry.started },
        pgid: entry.pgid > 0 ? entry.pgid : null,
        container: state?.container?.name ?? null,
      },
      opts,
    );
    if (supervisorStopped(report.supervisor)) opts.monitor.forget(name);
    reports.push(report);
  }
  return reports;
}
