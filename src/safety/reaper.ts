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
  container: "removed" | "absent" | "failed" | "none";
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
 * SIGTERM the group ⇒ grace ⇒ SIGKILL ⇒ remove the container.
 *
 * The container is removed even when the supervisor was `already_gone`: F25's
 * orphan is exactly a dead supervisor with a live container still burning
 * tokens, and skipping removal because the easier half of the cleanup was
 * done for us would leave the expensive half running.
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
    container = await ops.removeContainer(target.container);
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
 * Returns only the reaps performed; observation is the side effect that arms
 * the next cycle. Deregistration is deliberately NOT done here — the registry
 * has a single writer and mutations go through its RPC verbs, so the daemon
 * loop deregisters from the reports this returns rather than this module
 * growing a second write path to registry.json.
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
    opts.monitor.forget(name);
    reports.push(report);
  }
  return reports;
}
