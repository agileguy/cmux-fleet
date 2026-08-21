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
import { chmod, mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GroupReadError, processGroupId, realProcessOps } from "../../src/safety/kill.ts";
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

/** Every pid currently in a process group, straight from `ps`. */
async function groupMembers(pgid: number): Promise<number[]> {
  const p = Bun.spawn(["ps", "-o", "pid=", "-g", String(pgid)], {
    env: { ...process.env, LC_ALL: "C" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  return out
    .split("\n")
    .map((line) => Number.parseInt(line.trim(), 10))
    .filter((n) => Number.isInteger(n) && n > 0);
}

/**
 * A REAL process group with a leader and a non-leader member.
 *
 * Every fixture in this file until now recorded `pgid: null` (line 80) or
 * `pgid: 0` — both of which make `signalIfSame` skip `confirmGroup` entirely,
 * so no test here had ever reached the group check from the reaper at all. The
 * ISC-272 refusals were proved only against a fake OS in `kill.test.ts`, and
 * what the reaper DID with a refusal was proved nowhere.
 *
 * `detached: true` is what `supervisor/launch.ts` uses, and it is what makes
 * the shell a group leader in its own session — `pgid === pid`. That matters
 * for blast radius as much as for realism: a NON-detached `sleep` lives in the
 * TEST RUNNER's group, so a fixture that recorded its live pgid would aim any
 * regression at the suite itself. That is not hypothetical; it is the scar
 * `down-prune.test.ts` records. Here the only group any regression can reach is
 * this fixture's own.
 *
 * The `member` is the second process in that group: alive, real, and NOT the
 * leader, which is precisely the shape `confirmGroup` refuses as `not_led` and
 * precisely the shape a supervisor takes when it fails to detach.
 */
async function detachedGroup(): Promise<{
  pgid: number;
  leader: { pid: number; started: string };
  member: { pid: number; started: string };
  kill: () => void;
}> {
  const shell = Bun.spawn(["sh", "-c", "sleep 300 & sleep 300"], {
    detached: true,
    stdout: "ignore",
    stderr: "ignore",
  });
  shell.unref();
  const kill = () => {
    try {
      process.kill(-shell.pid, "SIGKILL");
    } catch {
      // Already reaped — the desired end state.
    }
  };
  for (let i = 0; i < 40; i++) {
    const members = await groupMembers(shell.pid);
    const other = members.find((pid) => pid !== shell.pid);
    if (other !== undefined) {
      const leaderStarted = await realProcessOps.startTime(shell.pid);
      const memberStarted = await realProcessOps.startTime(other);
      if (leaderStarted === null || memberStarted === null) break;
      return {
        pgid: shell.pid,
        leader: { pid: shell.pid, started: leaderStarted },
        member: { pid: other, started: memberStarted },
        kill,
      };
    }
    await new Promise((r) => setTimeout(r, 25));
  }
  kill();
  throw new Error(`detached group ${shell.pid} never acquired a second member`);
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

/**
 * `processGroupId`: "not there" and "could not find out" are different facts.
 *
 * IT LIVES HERE rather than in `test/unit/kill.test.ts` because it runs a real
 * `ps` — that file's header promises "every process here is fake" and it spawns
 * nothing. What is under test is the CLASSIFICATION of a real subprocess's exit
 * status and streams, which a fake ops table cannot reach: the fakes in
 * `kill.test.ts` cover what `confirmGroup` DOES with each answer, and these
 * cover which answer the real reader produces.
 *
 * THE STUB IS THE POINT. Forcing the real `/bin/ps` to fail in a specific way
 * is not portable — measured on Darwin 25.5, a reaped pid, a pid above the
 * ceiling, a malformed `-p` argument and an illegal flag ALL exit 1 with empty
 * stdout, and Linux `procps` was not available here to measure. A stub `ps` on
 * PATH makes each case exact and identical on every platform, and it is the
 * genuine `processGroupId` doing the classifying either way.
 */
describe("processGroupId: an absent process and a failed read are different facts", () => {
  /** Run `fn` with a stub `ps` script as the only executable on PATH. */
  async function withStubPs<T>(script: string, fn: () => Promise<T>): Promise<T> {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-stub-ps-"));
    const stub = join(dir, "ps");
    await Bun.write(stub, script);
    await chmod(stub, 0o755);
    const saved = process.env["PATH"];
    // ONLY the stub directory: a fall-through to the real `ps` would make a
    // failing assertion look like a passing one.
    process.env["PATH"] = dir;
    try {
      return await fn();
    } finally {
      if (saved === undefined) delete process.env["PATH"];
      else process.env["PATH"] = saved;
      await rm(dir, { recursive: true, force: true });
    }
  }

  /**
   * Fails if: `ps` saying nothing at all stops meaning "no such process". That
   * is the ONE reading a caller may act destructively on — `down` maps it to
   * the only anchor verdict that reports `stopped: true` and force-removes the
   * container — so it has to keep working, not merely be hard to reach.
   */
  test("silence on every channel is an absent process", async () => {
    expect(await withStubPs("#!/bin/sh\nexit 1\n", () => processGroupId(4242))).toBeNull();
    // One stub `ps` spawn. One.
  }, cliBudget(1));

  /**
   * THE F4 CASE. Same exit status and same empty stdout as the absent process
   * above; the only difference is that `ps` explained itself on stderr. Before
   * the split this returned `null` — indistinguishable from "gone" — so a
   * transient `ps` failure against a LIVE supervisor made `down` report it
   * stopped, `docker rm -f` its container, and `--prune` delete the checkout it
   * was still writing to.
   *
   * Fails if: a diagnosed failure is read as an absent process again.
   */
  test("a diagnosed failure is a failed read, not an absent process", async () => {
    await withStubPs(
      '#!/bin/sh\necho "ps: Resource temporarily unavailable" 1>&2\nexit 1\n',
      async () => {
        await expect(processGroupId(4242)).rejects.toBeInstanceOf(GroupReadError);
        await expect(processGroupId(4242)).rejects.toThrow(/Resource temporarily unavailable/);
      },
    );
    // TWO stub `ps` spawns, one per assertion — counted, not estimated.
  }, cliBudget(2));

  /**
   * A `ps` KILLED BY A SIGNAL, which is byte-identical to an absent process on
   * every channel this reader consults: bun reports `exitCode: null` (so
   * `exitCode !== 0` holds), and both pipes are empty.
   *
   * `processStartTime` got this guard and this test on the identity channel;
   * `processGroupId` got the guard and NOT the test, and an adversarial pass
   * proved the omission by reverting all five `kill.ts` guards at once and
   * watching 1335 unit and 19 reaper tests stay green. The guards were correct
   * and nothing held them there.
   *
   * The pid is `process.pid` DELIBERATELY: alive, and answered happily by any
   * real `ps` on any platform, so a fall-through past the stub fails loudly
   * instead of being rescued by a kernel that dislikes the number.
   *
   * Fails if: absence stops requiring a normal exit. `null` here is read as
   * `gone`, which is a caller's licence to `docker rm -f` a live supervisor's
   * container and prune the checkout it is writing to.
   */
  test("a `ps` killed by a signal is a failed read, not an absent process", async () => {
    await withStubPs("#!/bin/sh\nkill -9 $$\n", async () => {
      const err = await processGroupId(process.pid).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GroupReadError);
      expect((err as Error).message).toContain("killed by SIGKILL");
    });
    // One stub `ps` spawn.
  }, cliBudget(1));

  /**
   * No `ps` ON PATH AT ALL — the minimal-container case, and the likeliest
   * real instance of a broken measuring instrument.
   *
   * `Bun.spawn` throws SYNCHRONOUSLY here, before any of the outcome handling
   * below it exists, and the raw error carries no `exitCode` — so an unwrapped
   * spawn is reported by the entry point as `EXIT.INTERNAL`, "a bug in pifleet
   * itself", for what is purely an environment failure.
   *
   * Fails if: the spawn is unwrapped again. The INSTANCEOF is the load-bearing
   * assertion — an unwrapped spawn throws a bare `Error`, which does not
   * satisfy `toBeInstanceOf(GroupReadError)`.
   *
   * NOTE the asymmetry with `IdentityReadError`, which is deliberate and
   * documented in `kill.ts`: `GroupReadError` carries NO `exitCode`, because
   * every `processGroupId` call reaches it through `confirmGroup`, which
   * catches and converts to `read_failed` — it never travels to the CLI on its
   * own. `processStartTime` has callers that do not catch, so its error needs
   * the code. Asserting `exitCode` here would pin a property this type is
   * specifically not supposed to have.
   */
  test("a `ps` that is not on PATH at all is a diagnosed refusal", async () => {
    // An empty stub dir: `withStubPs` writes the script, so remove it first.
    await withStubPs("#!/bin/sh\nexit 0\n", async () => {
      const dir = process.env["PATH"]!;
      await rm(join(dir, "ps"), { force: true });
      const err = await processGroupId(process.pid).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(GroupReadError);
      expect((err as Error).message).toMatch(/could not be started/);
      // The contract this type DOES have: no exitCode, by design (above).
      expect((err as { exitCode?: number }).exitCode).toBeUndefined();
    });
    // No `ps` spawn succeeds, but the budget covers the attempt.
  }, cliBudget(1));

  /**
   * The third way a read can fail, and the one no exit status reveals: `ps`
   * claimed SUCCESS and printed something that is not a process group. An
   * unparseable answer is not an answer.
   *
   * Fails if: unparseable output falls back to `null` — which is what the
   * original `Number.isInteger(pgid) && pgid > 0 ? pgid : null` did, feeding
   * the same "gone" verdict from a third direction.
   */
  test("output that is not a process group is a failed read", async () => {
    await withStubPs('#!/bin/sh\necho "not-a-number"\nexit 0\n', async () => {
      await expect(processGroupId(4242)).rejects.toBeInstanceOf(GroupReadError);
    });
    // One stub `ps` spawn. One.
  }, cliBudget(1));

  /**
   * The real binary, unstubbed, on both sides of the fact — so the stubs above
   * are anchored to something actually true of this machine's `ps` rather than
   * to scripts that agree with them by construction.
   *
   * Fails if: a live pid stops yielding its group, or a reaped one stops
   * reading as absent.
   */
  test("the real ps: a live pid has a group, a reaped pid has none", async () => {
    const victim = await spawnVictim(["sleep", "300"]);
    const live = await processGroupId(victim.pid);
    expect(live).not.toBeNull();
    expect(live!).toBeGreaterThan(0);

    victim.kill();
    for (let i = 0; i < 80; i++) {
      if ((await realProcessOps.startTime(victim.pid)) === null) break;
      await new Promise((r) => setTimeout(r, 25));
    }
    expect(await processGroupId(victim.pid)).toBeNull();
    // One victim spawn, plus one charge for the `ps` traffic — two
    // `processGroupId` reads and the death poll. Two.
  }, cliBudget(2));
});

/**
 * A REAP THAT STOPPED NOTHING MUST DESTROY NOTHING (ISC-272).
 *
 * `group_unconfirmed` means the supervisor is ALIVE and was deliberately not
 * signalled. `down` honours that — it refuses, keeps the container and keeps
 * the checkout. The reaper did not: it gated `docker rm -f` on the container
 * merely EXISTING, the daemon deleted the registry entry for every report it
 * was handed, and `monitor.forget` dropped the staleness clock. A supervisor
 * that is not its own group leader therefore had its live container removed
 * mid-write, vanished from `registry.json`, and became invisible to every later
 * scan — an orphan holding a worktree nothing on the host still named.
 *
 * These probes reach `confirmGroup` from the reaper, which no test in this file
 * did before: every fixture recorded `pgid: null` or `pgid: 0`, both of which
 * make `signalIfSame` skip the group check entirely.
 */
describe("a reap that refused to stop anything destroys nothing", () => {
  function frozenState(container: string | null): WorkerState {
    return WorkerStateSchema.parse({
      schema: "pifleet.state/v1",
      worker: "w-1",
      run_id: "r-1",
      pid: 1,
      pgid: 0,
      started_at: "2026-07-27T09:00:00Z",
      phase: "busy",
      epoch: 1,
      heartbeat_at: "2026-07-27T10:00:00Z",
      container: container === null ? null : { name: container, id: "abc", image: "img" },
    });
  }

  /**
   * `mismatch`: the record names a group the OS does not put this process in —
   * a stale or hand-edited state file, which is the entire premise of reading
   * one at all.
   *
   * The recorded number is deliberately `pgid + 1_000_000`, far above any pid
   * this kernel will issue, so it cannot name a live group. That is blast-radius
   * insurance rather than realism: if the confirmation is ever deleted, the
   * signal goes to a group that does not exist and fails with ESRCH instead of
   * reaching a bystander — and the `container` assertion below still catches the
   * regression, because ESRCH reads as `already_gone` and `already_gone` removes.
   *
   * Fails if: the container is removed on an outcome that never stopped
   * anything — the live supervisor keeps writing to a worktree whose container
   * has been torn out from under it.
   */
  test("a group the record disagrees with: nothing signalled, the container is spared", async () => {
    const g = await detachedGroup();
    try {
      const { ops, removed } = opsWithFakeDocker();
      const report = await reapSupervisor(
        {
          worker: "w-mismatch",
          proc: g.leader,
          pgid: g.pgid + 1_000_000,
          container: "pifleet-w-mismatch",
        },
        { ops, ...FAST },
      );
      expect(report.supervisor).toBe("group_unconfirmed");
      expect(report.container).toBe("spared");
      expect(removed).toEqual([]);
      expect(await alive(g.leader.pid)).toBe(g.leader.started);
      expect(await alive(g.member.pid)).toBe(g.member.started);
    } finally {
      g.kill();
    }
    // ONE fixture spawn (a detached `sh` that forks two `sleep`s), plus one
    // charge for the `ps` traffic: the group-membership poll, two identity
    // reads for the fixture, and the ladder's own reads. Two.
  }, cliBudget(2));

  /**
   * `not_led`: record and OS agree perfectly, and the group still belongs to
   * somebody else, because the target is a MEMBER of it rather than its leader.
   * That is exactly a supervisor that failed to detach and shares its
   * launcher's group — the case where `-pgid` would reach the launcher and all
   * of its other children.
   *
   * Fails if: the container is removed, or either process dies. The leader
   * assertion is the load-bearing one — it is the process a group signal would
   * have reached in addition to the target.
   */
  test("a group the supervisor does not LEAD: nothing signalled, the container is spared", async () => {
    const g = await detachedGroup();
    try {
      const { ops, removed } = opsWithFakeDocker();
      const report = await reapSupervisor(
        {
          worker: "w-notled",
          proc: g.member,
          pgid: g.pgid,
          container: "pifleet-w-notled",
        },
        { ops, ...FAST },
      );
      expect(report.supervisor).toBe("group_unconfirmed");
      expect(report.container).toBe("spared");
      expect(removed).toEqual([]);
      expect(await alive(g.member.pid)).toBe(g.member.started);
      expect(await alive(g.leader.pid)).toBe(g.leader.started);
    } finally {
      g.kill();
    }
    // Same derivation as the mismatch probe above: one fixture spawn plus one
    // for the `ps` traffic. Two.
  }, cliBudget(2));

  /**
   * The staleness clock is the part that decides whether a refusal is a RETRY
   * or an amnesia. `monitor.forget` was called for every report; for a worker
   * that is still alive and still registered that resets its staleness to zero,
   * so it has to spend another full 3x interval going stale before anything
   * looks at it again — every cycle, forever.
   *
   * Fails if: the clock is forgotten for an un-stopped worker. The second scan
   * then reaps nothing, because the worker it refused a moment ago now reads as
   * freshly observed.
   */
  test("a refused supervisor keeps its staleness clock and is retried next scan", async () => {
    const g = await detachedGroup();
    try {
      const registry = RegistrySchema.parse({
        schema: "pifleet.registry/v1",
        run_id: "r-1",
        daemon: { pid: process.pid, started: "x" },
        workers: {
          "w-1": {
            worker: "w-1",
            pid: g.member.pid,
            pgid: g.pgid, // positive, real — and led by someone else
            started: g.member.started,
            registered_at: "2026-07-27T09:00:00Z",
          },
        },
      });

      let t = 0;
      const monitor = new HeartbeatMonitor(() => t);
      const { ops, removed } = opsWithFakeDocker();
      const cycle = () =>
        reapStale({
          registry,
          readState: () => Promise.resolve(frozenState("pifleet-w-1")),
          monitor,
          heartbeatIntervalMs: 1_000,
          ops,
          ...FAST,
        });

      expect(await cycle()).toEqual([]); // first scan only observes
      t += 60_000;

      const first = await cycle();
      expect(first.map((r) => r.supervisor)).toEqual(["group_unconfirmed"]);
      expect(first[0]!.container).toBe("spared");
      expect(removed).toEqual([]);

      // The clock survived the refusal: still the full stale interval, not the
      // zero a forgotten worker reads.
      expect(monitor.sinceChangeMs("w-1")).toBe(60_000);

      // ...which is what makes the next scan try again instead of starting the
      // staleness wait over from nothing.
      const second = await cycle();
      expect(second.map((r) => r.supervisor)).toEqual(["group_unconfirmed"]);

      expect(await alive(g.member.pid)).toBe(g.member.started);
      expect(await alive(g.leader.pid)).toBe(g.leader.started);
    } finally {
      g.kill();
    }
    // One fixture spawn; one for the `ps` traffic of three scans plus the
    // fixture's own reads. Two.
  }, cliBudget(2));
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

  /**
   * `pgid` defaults to the capture-failed sentinel `0`, which is what every
   * probe here recorded before ISC-272 had a reaper-side test: a non-positive
   * group makes `reapStale` pass `pgid: null` and the ladder never reaches
   * `confirmGroup`. Pass a real, positive one to exercise the group check.
   */
  function entry(worker: string, proc: { pid: number; started: string }, pgid = 0) {
    return {
      worker,
      pid: proc.pid,
      pgid,
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

  /**
   * The deregistration half of the same rule. `registry.json` is what `status`
   * and `down` read to find out what this run is running, so deleting an entry
   * ASSERTS there is no supervisor behind that name. The daemon deleted every
   * worker it was handed a report for, including the ones the ladder refused to
   * signal — so a live supervisor lost its name, `down` could no longer stop
   * it, and the next scan could no longer see it to try again.
   *
   * Fails if: an un-stopped supervisor is deregistered. The on-disk assertion
   * is the load-bearing one; an in-memory-only survival would still leave every
   * other process reading a file that says the worker is gone.
   */
  test("a supervisor the ladder refused to stop stays registered", async () => {
    const { run, cleanup } = await scratchRun();
    const g = await detachedGroup();
    let clock = 0;
    const announced: string[] = [];
    const { ops, removed } = opsWithFakeDocker();

    const daemon = await startRegistryDaemon(run, {
      reaper: {
        heartbeatIntervalMs: 1_000,
        scanIntervalMs: 3_600_000,
        readState: (w) => Promise.resolve(state(w, "2026-07-27T10:00:00Z")),
        now: () => clock,
        ops,
        onReap: (rs) => announced.push(...rs.map((r) => r.worker)),
        ...FAST,
      },
    });

    try {
      const secret = await loadControlSecret(run);
      // A MEMBER of a real group, not its leader: the shape `confirmGroup`
      // refuses as `not_led`, recorded with the positive pgid that makes the
      // reaper actually ask.
      await socketRequest(run.daemonSock, {
        cmd: "register_worker",
        entry: entry("w-1", g.member, g.pgid),
      }, { secret });

      expect(await daemon.reapOnce()).toEqual([]); // observe only
      clock += 60_000;

      const reports = await daemon.reapOnce();
      expect(reports.map((r) => r.supervisor)).toEqual(["group_unconfirmed"]);

      // Alive, un-signalled, and STILL REGISTERED on disk.
      expect(await alive(g.member.pid)).toBe(g.member.started);
      expect(await alive(g.leader.pid)).toBe(g.leader.started);
      expect((await readRegistry(run))?.workers["w-1"]).toBeDefined();
      expect(removed).toEqual([]);
      // The refusal is still announced: a live supervisor this run cannot prove
      // it owns is precisely the fact an operator needs out of the ledger.
      expect(announced).toEqual(["w-1"]);
    } finally {
      await daemon.stop();
      g.kill();
      await cleanup();
    }
    // One fixture spawn; one for the daemon's own startup `ps`; one for the
    // `ps` traffic of two scans. Three.
  }, cliBudget(3));

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
