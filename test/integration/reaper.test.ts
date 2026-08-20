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
import {
  RegistrySchema,
  readRegistry,
  socketRequest,
  startRegistryDaemon,
} from "../../src/run/registry.ts";
import { runPaths, type RunPaths } from "../../src/run/paths.ts";
import { loadControlSecret } from "../../src/security/control-auth.ts";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import { cliBudget } from "../support/budget.ts";

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
  }, cliBudget(1));

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
  }, cliBudget(1));

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
  }, cliBudget(1));

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
  }, cliBudget(1));
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
  }, cliBudget(1));
});

/**
 * The daemon's reaper loop (ISC-236).
 *
 * `reapStale` had full coverage above while nothing in production called it —
 * a tested mechanism with no live call site, which is indistinguishable from
 * a dead one at runtime. These probes go through `startRegistryDaemon`, so
 * they fail if the wiring is removed, if the reaper config stops being passed,
 * or if the reap stops being reflected in `registry.json`.
 *
 * Cycles are driven with `reapOnce()` rather than by waiting for the interval:
 * a test that sleeps past a timer is racing the path it is trying to prove.
 */
describe("the daemon reaps and deregisters", () => {
  async function scratchRun(): Promise<{ run: RunPaths; cleanup: () => Promise<void> }> {
    const root = await mkdtemp(join(tmpdir(), "pifleet-daemon-"));
    // Unique per process: `socketPath` hashes (run_id, worker) into the SHARED
    // os.tmpdir(), so a fixed id makes two concurrent test processes bind the
    // same daemon socket and answer each other's RPCs.
    const run = runPaths(`r-reap-${process.pid.toString(36)}${Math.random().toString(36).slice(2, 8)}`, root);
    await mkdir(run.root, { recursive: true });
    return { run, cleanup: () => rm(root, { recursive: true, force: true }) };
  }

  function entry(worker: string, proc: { pid: number; started: string }) {
    return {
      worker,
      pid: proc.pid,
      pgid: 0,
      started: proc.started,
      registered_at: "2026-07-27T09:00:00Z",
    };
  }

  function state(worker: string, heartbeatAt: string): WorkerState {
    return WorkerStateSchema.parse({
      schema: "pifleet.state/v1",
      worker,
      run_id: "r-reap",
      pid: 1,
      pgid: 0,
      started_at: "2026-07-27T09:00:00Z",
      phase: "busy",
      epoch: 1,
      heartbeat_at: heartbeatAt,
      container: null,
    });
  }

  test("a wedged supervisor is killed, deregistered, and persisted as gone", async () => {
    const { run, cleanup } = await scratchRun();
    const victim = await spawnVictim(["sleep", "300"]);
    let clock = 0;
    let label = "2026-07-27T10:00:00Z";
    const announced: string[] = [];
    const { ops } = opsWithFakeDocker();

    const daemon = await startRegistryDaemon(run, {
      reaper: {
        heartbeatIntervalMs: 1_000,
        // Long enough that the interval cannot fire during the test: every
        // cycle here is one this test asked for.
        scanIntervalMs: 3_600_000,
        readState: (w) => Promise.resolve(state(w, label)),
        now: () => clock,
        ops,
        onReap: (rs) => announced.push(...rs.map((r) => r.worker)),
        ...FAST,
      },
    });

    try {
      // The daemon minted the run's control secret at startup; every socket
      // verb — this one included — must present it (SRD §12.7).
      const secret = await loadControlSecret(run);
      await socketRequest(run.daemonSock, {
        cmd: "register_worker",
        entry: entry("w-1", victim),
      }, { secret });
      expect((await readRegistry(run))?.workers["w-1"]).toBeDefined();

      // First cycle only observes: a worker seen once is not yet stale.
      expect(await daemon.reapOnce()).toEqual([]);
      expect(await alive(victim.pid)).toBe(victim.started);
      expect((await readRegistry(run))?.workers["w-1"]).toBeDefined();
      expect(announced).toEqual([]);

      // The label freezes while the daemon's own clock passes 3x the interval.
      clock += 60_000;
      const reports = await daemon.reapOnce();
      expect(reports.map((r) => r.worker)).toEqual(["w-1"]);
      expect(["terminated", "killed"]).toContain(reports[0]!.supervisor);

      // Really dead, and really gone from the registry ON DISK — the file is
      // what `status` and `down` read, so an in-memory-only removal would
      // leave a reaped worker looking registered to every other process.
      expect(await alive(victim.pid)).toBeNull();
      expect((await readRegistry(run))?.workers["w-1"]).toBeUndefined();
      // The observability hook is how `daemon` gets a `worker_reaped` ledger
      // row; a reap nobody is told about is one nobody can audit afterwards.
      expect(announced).toEqual(["w-1"]);
    } finally {
      await daemon.stop();
      victim.kill();
      await cleanup();
    }
  }, cliBudget(2));

  test("a healthy worker survives every cycle", async () => {
    const { run, cleanup } = await scratchRun();
    const victim = await spawnVictim(["sleep", "300"]);
    let clock = 0;
    let beat = 0;
    const { ops } = opsWithFakeDocker();

    const daemon = await startRegistryDaemon(run, {
      reaper: {
        heartbeatIntervalMs: 1_000,
        scanIntervalMs: 3_600_000,
        // A label that keeps MOVING is a live supervisor, whatever the clocks
        // disagree about.
        readState: (w) => Promise.resolve(state(w, `2026-07-27T10:00:${beat++}Z`)),
        now: () => clock,
        ops,
        ...FAST,
      },
    });

    try {
      const secret = await loadControlSecret(run);
      await socketRequest(run.daemonSock, {
        cmd: "register_worker",
        entry: entry("w-1", victim),
      }, { secret });
      for (let i = 0; i < 4; i++) {
        clock += 60_000;
        expect(await daemon.reapOnce()).toEqual([]);
      }
      expect(await alive(victim.pid)).toBe(victim.started);
      expect((await readRegistry(run))?.workers["w-1"]).toBeDefined();
    } finally {
      await daemon.stop();
      victim.kill();
      await cleanup();
    }
  }, cliBudget(2));
  /**
   * A scan reaps against the worker set it STARTED with. Reaping is slow — the
   * kill ladder waits out two grace periods — and `up` registers workers
   * concurrently, so a scan that wrote back its own snapshot would erase every
   * worker that appeared while it ran. Those workers are alive and supervised;
   * losing them from the registry means `down` never stops them and `status`
   * never shows them.
   *
   * The probe holds the scan open inside `readState` and registers a second
   * worker while it is suspended.
   */
  test("a worker registered mid-scan is not erased by that scan", async () => {
    const { run, cleanup } = await scratchRun();
    const victim = await spawnVictim(["sleep", "300"]);
    const bystander = await spawnVictim(["sleep", "300"]);
    let clock = 0;
    const { ops } = opsWithFakeDocker();

    let releaseScan: () => void = () => {};
    const scanReachedWorker = new Promise<void>((resolve) => {
      releaseScan = resolve;
    });
    let held = false;

    const daemon = await startRegistryDaemon(run, {
      reaper: {
        heartbeatIntervalMs: 1_000,
        scanIntervalMs: 3_600_000,
        readState: async (w) => {
          if (!held) {
            held = true;
            await scanReachedWorker;
          }
          return state(w, "2026-07-27T10:00:00Z");
        },
        now: () => clock,
        ops,
        ...FAST,
      },
    });

    try {
      const secret = await loadControlSecret(run);
      await socketRequest(run.daemonSock, {
        cmd: "register_worker",
        entry: entry("w-1", victim),
      }, { secret });
      // Observe once so w-1 has a frozen label to go stale against.
      held = true; // the gate is for the SECOND scan, not this one
      expect(await daemon.reapOnce()).toEqual([]);

      clock += 60_000;
      held = false;
      const scan = daemon.reapOnce();

      // The scan is now suspended inside readState, holding a snapshot that
      // contains only w-1. Register w-2 into the live registry underneath it.
      await socketRequest(run.daemonSock, {
        cmd: "register_worker",
        entry: entry("w-2", bystander),
      }, { secret });
      releaseScan();

      const reports = await scan;
      expect(reports.map((r) => r.worker)).toEqual(["w-1"]);

      const after = await readRegistry(run);
      expect(after?.workers["w-1"]).toBeUndefined();
      // The whole point: w-2 arrived after the snapshot and must survive it.
      expect(after?.workers["w-2"]).toBeDefined();
      expect(await alive(bystander.pid)).toBe(bystander.started);
    } finally {
      await daemon.stop();
      victim.kill();
      bystander.kill();
      await cleanup();
    }
  }, cliBudget(3));
});
