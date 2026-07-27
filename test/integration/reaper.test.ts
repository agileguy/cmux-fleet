/**
 * safety/reaper.ts — against real processes (ISC-118, ISC-191).
 *
 * The ladder's unit tests fake the OS; these do not. A reaper's whole job is
 * to be right about which real process dies, so the probes here spawn real
 * children, reap them with the real `ps`-backed identity ops, and assert on
 * what the kernel says afterwards. The pid-reuse probe is the one that
 * matters: it aims the reaper at a LIVE pid with the WRONG start time and
 * passes only if that process survives.
 *
 * Grace periods are short real milliseconds — these tests wait for positive
 * death signals (identity disappearance), never race a timer against the
 * path under test. Container removal stays faked: `docker rm -f` against a
 * real daemon belongs to the Docker-gated suite, not here.
 */

import { describe, expect, test } from "bun:test";
import { WorkerStateSchema, type WorkerState } from "../../src/contracts.ts";
import { RegistrySchema } from "../../src/run/registry.ts";
import { realProcessOps } from "../../src/safety/kill.ts";
import {
  HeartbeatMonitor,
  isStale,
  reapStale,
  reapSupervisor,
  realReaperOps,
  STALE_HEARTBEAT_MULTIPLIER,
  type ReaperOps,
  type ReapTarget,
} from "../../src/safety/reaper.ts";

const FAST = { termGraceMs: 500, killGraceMs: 500, pollMs: 25 };

/** Reaper ops with real signals/ps but a recording container fake. */
function opsWithFakeDocker(): { ops: ReaperOps; removed: string[] } {
  const removed: string[] = [];
  const ops: ReaperOps = {
    ...realProcessOps,
    removeContainer(name) {
      removed.push(name);
      return Promise.resolve("removed");
    },
  };
  return { ops, removed };
}

/** Spawn a real child and resolve its recorded (pid, started) identity. */
async function spawnVictim(cmd: string[]): Promise<{ pid: number; started: string; kill: () => void }> {
  const child = Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  const started = await realProcessOps.startTime(child.pid);
  if (started === null) throw new Error(`victim ${child.pid} vanished before ps saw it`);
  return {
    pid: child.pid,
    started,
    kill: () => {
      try {
        child.kill(9);
      } catch {
        // already gone — the desired end state.
      }
    },
  };
}

const alive = (pid: number) => realProcessOps.startTime(pid);

function target(worker: string, proc: { pid: number; started: string }): ReapTarget {
  return { worker, proc, pgid: null, container: null };
}

describe("reapSupervisor against real processes", () => {
  /**
   * Fails if: the ladder stops delivering real signals (fake-ops tests can't
   * see that), or the default death signal stops tracking identity
   * disappearance — the reap would report success over a live process.
   */
  test("ISC-118: a live supervisor is reaped and is really gone afterwards", async () => {
    const victim = await spawnVictim(["sleep", "300"]);
    try {
      const { ops } = opsWithFakeDocker();
      const report = await reapSupervisor(target("w-live", victim), { ops, ...FAST });
      expect(["terminated", "killed"]).toContain(report.supervisor);
      expect(await alive(victim.pid)).toBeNull(); // the kernel agrees
    } finally {
      victim.kill();
    }
  });

  /**
   * THE ISC-191 probe, on a real kernel. The registry remembers a dead
   * supervisor; its pid now belongs to someone else (simulated by recording
   * a start time that matches no process). Fails if: any rung falls back to
   * pid-only identity — the innocent process dies and the `alive` assertion
   * catches the murder.
   */
  test("ISC-191: a recycled pid is not signalled — the inheritor survives", async () => {
    const victim = await spawnVictim(["sleep", "300"]);
    try {
      const stale = { pid: victim.pid, started: "Mon Jan  1 00:00:00 2001" };
      const { ops, removed } = opsWithFakeDocker();
      const report = await reapSupervisor(
        { ...target("w-recycled", stale), container: "pifleet-w-recycled" },
        { ops, ...FAST },
      );
      expect(report.supervisor).toBe("already_gone");
      expect(await alive(victim.pid)).toBe(victim.started); // untouched
      // The dead supervisor's container is still removed: an orphaned
      // container burning tokens is F25, and the easy half of the cleanup
      // being done already must not skip the expensive half.
      expect(removed).toEqual(["pifleet-w-recycled"]);
    } finally {
      victim.kill();
    }
  });

  /**
   * Fails if: reaping the already-dead becomes an error — the daemon's scan
   * routinely loses the race against a supervisor's own clean exit, and
   * ISC-118 requires that losing it is a no-op.
   */
  test("ISC-118: reaping twice is idempotent — the second pass is already_gone", async () => {
    const victim = await spawnVictim(["sleep", "300"]);
    const { ops } = opsWithFakeDocker();
    const t = target("w-twice", victim);
    try {
      const first = await reapSupervisor(t, { ops, ...FAST });
      expect(["terminated", "killed"]).toContain(first.supervisor);
    } finally {
      victim.kill();
    }
    const second = await reapSupervisor(t, { ops, ...FAST });
    expect(second.supervisor).toBe("already_gone");
  });

  /**
   * Fails if: the SIGKILL rung is removed or gated on SIGTERM having worked
   * — a supervisor wedged hard enough to ignore TERM (this one ignores it by
   * inheritance across exec) would survive the reaper forever.
   */
  test("a SIGTERM-immune supervisor still dies on the SIGKILL rung", async () => {
    const victim = await spawnVictim(["bash", "-c", "trap '' TERM; exec sleep 300"]);
    try {
      const { ops } = opsWithFakeDocker();
      const report = await reapSupervisor(target("w-immune", victim), { ops, ...FAST });
      expect(report.supervisor).toBe("killed");
      expect(await alive(victim.pid)).toBeNull();
    } finally {
      victim.kill();
    }
  });
});

describe("HeartbeatMonitor: staleness is change-detection on a monotonic clock", () => {
  /**
   * Fails if: staleness goes back to subtracting the wall-clock label from
   * the daemon's wall clock (ISC-146/155) — under this fake clock the labels
   * never change value, so only monotonic elapsed-since-change can trip.
   */
  test("a frozen label goes stale; a changing label never does", () => {
    let t = 0;
    const m = new HeartbeatMonitor(() => t);
    const intervalMs = 5_000;

    m.observe("frozen", "2026-07-27T10:00:00Z");
    m.observe("beating", "2026-07-27T10:00:00Z");
    for (let i = 1; i <= 4; i++) {
      t += intervalMs;
      m.observe("frozen", "2026-07-27T10:00:00Z"); // same label — no progress
      m.observe("beating", `2026-07-27T10:00:0${i}Z`); // label moved — alive
    }
    expect(isStale(m.sinceChangeMs("frozen"), intervalMs)).toBe(true);
    expect(isStale(m.sinceChangeMs("beating"), intervalMs)).toBe(false);
  });

  /**
   * Fails if: the §13.1 multiplier drifts, or the boundary becomes >= —
   * "older than 3×" is strict, and a heartbeat landing exactly on the line
   * is late, not dead.
   */
  test("the threshold is strictly greater than 3x the interval", () => {
    const intervalMs = 1_000;
    expect(STALE_HEARTBEAT_MULTIPLIER).toBe(3);
    expect(isStale(3_000, intervalMs)).toBe(false);
    expect(isStale(3_001, intervalMs)).toBe(true);
  });

  /**
   * Fails if: a never-observed worker starts stale — a daemon restart would
   * mass-reap a healthy fleet before its first scan completed.
   */
  test("an unobserved worker is not stale", () => {
    const m = new HeartbeatMonitor(() => 99_999_999);
    expect(m.sinceChangeMs("never-seen")).toBe(0);
  });
});

describe("reapStale: one scan over a real registry shape", () => {
  function fakeState(heartbeatAt: string, container: string | null): WorkerState {
    return WorkerStateSchema.parse({
      schema: "pifleet.state/v1",
      worker: "w-1",
      run_id: "r-1",
      pid: 1,
      pgid: 0,
      started_at: "2026-07-27T09:00:00Z",
      phase: "busy",
      epoch: 1,
      heartbeat_at: heartbeatAt,
      container: container === null ? null : { name: container, id: "abc", image: "img" },
    });
  }

  /**
   * Fails if: the scan reaps on its FIRST observation of a worker, judges
   * staleness from wall labels, or stops reaping when the threshold is
   * crossed. The victim is a real process; only the stale scan may kill it.
   */
  test("a frozen heartbeat is reaped; the reap is real; healthy scans reap nothing", async () => {
    const victim = await spawnVictim(["sleep", "300"]);
    try {
      const registry = RegistrySchema.parse({
        schema: "pifleet.registry/v1",
        run_id: "r-1",
        daemon: { pid: process.pid, started: "x" },
        workers: {
          "w-1": {
            worker: "w-1",
            pid: victim.pid,
            pgid: 0,
            started: victim.started,
            registered_at: "2026-07-27T09:00:00Z",
          },
        },
      });

      let t = 0;
      const monitor = new HeartbeatMonitor(() => t);
      const { ops, removed } = opsWithFakeDocker();
      const cycle = (label: string) =>
        reapStale({
          registry,
          readState: () => Promise.resolve(fakeState(label, "pifleet-w-1")),
          monitor,
          heartbeatIntervalMs: 1_000,
          ops,
          ...FAST,
        });

      // First scan observes; nothing is stale yet, nothing dies.
      expect(await cycle("2026-07-27T10:00:00Z")).toEqual([]);
      expect(await alive(victim.pid)).toBe(victim.started);

      // The label freezes while the daemon's clock advances past 3x.
      t += 60_000;
      const reports = await cycle("2026-07-27T10:00:00Z");
      expect(reports).toHaveLength(1);
      expect(["terminated", "killed"]).toContain(reports[0]!.supervisor);
      expect(removed).toEqual(["pifleet-w-1"]);
      expect(await alive(victim.pid)).toBeNull();
    } finally {
      victim.kill();
    }
  });
});
