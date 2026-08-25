/**
 * The launch record — `supervisor/launch.ts` — against real processes
 * (ISC-191, ISC-272).
 *
 * WHAT THESE PROBE THAT THE DOWNSTREAM SUITES CANNOT. `down-identity.test.ts`
 * and `kill.test.ts` prove what the READER does with a record: it re-reads the
 * pair from the OS at every rung, refuses a group the validated leader does not
 * lead, and refuses rather than degrading when anything is unrecorded. Every one
 * of those checks compares the record against the OS. None of them can catch a
 * record that was WRITTEN from the OS in the first place — a `(pid, started,
 * pgid)` triple read off a pid the kernel had already reissued is internally
 * consistent, agrees with the OS at every later rung, and names a process the
 * run never launched. The whole ladder then climbs in good faith and SIGKILLs a
 * stranger's process group.
 *
 * So these tests aim at the WRITE. The question is not "does `down` check the
 * record" — it does — but "does the record describe the process the launcher
 * started, or merely whatever holds the number".
 *
 * THE STUB `ps` IS THE POINT, and it is the same technique `reaper.test.ts`
 * uses for the same reason. Forcing the real `/bin/ps` to answer about a
 * reissued pid is not something a test can arrange: it would have to win a race
 * with the kernel's pid allocator. A stub makes the hostile answer exact and
 * identical on every platform, and it is the genuine `launchDetached` doing the
 * deciding either way. The stub answers AFFIRMATIVELY — that is what makes it
 * hostile. A stub that failed would be caught by the capture-failed sentinels
 * that already existed; the record that has never been refused is the confident
 * wrong one.
 */

import { describe, expect, test } from "bun:test";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { processLauncher } from "../../src/supervisor/launch.ts";
import { confirmGroup, realProcessOps, runKillLadder } from "../../src/safety/kill.ts";
import { IDENTITY_FORMAT, processStartTime } from "../../src/run/registry.ts";
import { cliBudget } from "../support/budget.ts";

const bases: string[] = [];
const groups: number[] = [];

/**
 * Everything a `WorkerSpec` needs that is not the argv. The run directory is a
 * scratch dir per call: `launchDetached` only writes the supervisor log, and a
 * shared one would let two tests' children interleave into the same file.
 */
async function spec(argv: string[]): Promise<Parameters<typeof processLauncher.launchDetached>[0]> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-launchrec-"));
  bases.push(base);
  return {
    runId: "2026-08-23T00-00-00Z-lrec",
    runDir: base,
    workerId: "eng-1",
    /*
     * ABSOLUTE argv[0], deliberately. The stub-`ps` tests replace PATH with a
     * directory containing nothing but `ps`, and the child inherits that PATH —
     * a bare `sh` would fail to resolve and the test would pass for the wrong
     * reason.
     */
    argv,
    env: {},
    logPath: join(base, "supervisor.log"),
  };
}

/** Run `fn` with a stub `ps` script as the only executable on PATH. */
async function withStubPs<T>(script: string, fn: () => Promise<T>): Promise<T> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-launchrec-ps-"));
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
 * A stub `ps` that answers about ANY pid as a live, self-leading process would.
 *
 * This is a stranger that inherited a reissued pid, written down: it reports
 * the queried pid as its own process group leader and hands back a start time
 * in the pinned rendering. Both reads succeed, so nothing downstream of the
 * launcher could tell this record from a real one.
 *
 * `$2` is the format (`pgid=` / `lstart=`) and `$4` is the pid — the argv both
 * readers build is `ps -o <fmt> -p <pid>`.
 */
const STUB_PS_ANSWERS_FOR_ANYONE = [
  "#!/bin/sh",
  'case "$2" in',
  '  pgid=) echo "$4" ;;',
  '  lstart=) echo "Thu 20 Aug 06:44:42 2026" ;;',
  "  *) exit 1 ;;",
  "esac",
  "exit 0",
  "",
].join("\n");

/** The same stranger, but one that puts the pid in somebody ELSE's group. */
const STUB_PS_FOREIGN_GROUP = [
  "#!/bin/sh",
  'case "$2" in',
  '  pgid=) echo "1" ;;',
  '  lstart=) echo "Thu 20 Aug 06:44:42 2026" ;;',
  "  *) exit 1 ;;",
  "esac",
  "exit 0",
  "",
].join("\n");

/** Every pid currently in a process group, straight from `ps`. */
async function groupMembers(pgid: number): Promise<number[]> {
  const p = Bun.spawn(["ps", "-o", "pid=", "-g", String(pgid)], {
    env: { ...process.env, LC_ALL: "C" },
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = await new Response(p.stdout).text();
  await p.exited;
  if (p.exitCode !== 0) return [];
  return out
    .trim()
    .split("\n")
    .map((l) => Number.parseInt(l.trim(), 10))
    .filter((n) => Number.isInteger(n));
}

async function cleanup(): Promise<void> {
  for (const pgid of groups.splice(0)) {
    try {
      process.kill(-pgid, "SIGKILL");
    } catch {
      // Already gone. Reaping the dead is a no-op, not an error.
    }
  }
  for (const base of bases.splice(0)) await rm(base, { recursive: true, force: true });
}

// ---------------------------------------------------------------------------
// The record describes the process the launcher started (ISC-272)
// ---------------------------------------------------------------------------

describe("launchDetached records an identity, never a read off a live pid (ISC-272)", () => {
  /**
   * THE POSITIVE DIRECTION. A record `confirmGroup` accepts, produced by the
   * real launcher against a real detached child.
   *
   * Without this the three refusals below are satisfiable by a launcher that
   * refuses everything, which would pass every negative test and ship a fleet
   * no `down` could stop.
   *
   * Fails if: the launcher stops recording a usable identity, or records a
   * group the supervisor does not lead.
   */
  test("ISC-272: a live supervisor's record names the group it leads, and confirmGroup accepts it", async () => {
    try {
      const rec = await processLauncher.launchDetached(await spec(["/bin/sh", "-c", "sleep 30 & sleep 30"]));
      groups.push(rec.pid);

      // `detached: true` makes the supervisor a group leader in its own
      // session — ISC-77/78's observable proof, now CHECKED at the moment it
      // is relied upon rather than asserted by a comment.
      expect(rec.pgid).toBe(rec.pid);
      expect(rec.started.startsWith(`${IDENTITY_FORMAT} `)).toBe(true);
      // The pinned rendering, not whatever the launcher's TZ and locale
      // happened to be — the record is compared byte-for-byte by another
      // process in another environment.
      expect(rec.started).toBe((await processStartTime(rec.pid)) ?? "");

      const verdict = await confirmGroup(
        { pid: rec.pid, started: rec.started },
        rec.pgid,
        realProcessOps,
      );
      expect(verdict).toEqual({ ok: true, pgid: rec.pid });
    } finally {
      await cleanup();
    }
    // One spawn for the supervisor, one `ps -o pgid=` and one `ps -o lstart=`
    // inside `launchDetached`, one `processStartTime` for the comparison, and
    // two more `ps` inside `confirmGroup`'s read plus its identity path. Seven.
  }, cliBudget(7));

  /**
   * THE MUTATION PROBE FOR THE REAPED-CHILD GUARD.
   *
   * The child exits immediately and is reaped, so its pid is free for the
   * kernel to hand to anybody. The stub `ps` then answers about that pid the
   * way a stranger holding it would: alive, and its own group leader. Every
   * read SUCCEEDS. The pre-guard launcher recorded that answer as this run's
   * launch identity — a complete, confident triple naming a process the run
   * never started, which `anchorIdentity` would then agree with, `sameIdentity`
   * would confirm at every rung, and `confirmGroup` would confirm the group of.
   *
   * `registry.ts` called this capture site "weaker than the other two" and said
   * the consequence was the `""` sentinel. `""` is what a reaped-and-IDLE pid
   * produces. This is what a reaped-and-REISSUED pid produces, and it is the
   * opposite of a sentinel.
   *
   * Fails if: `launchDetached` stops requiring the child handle to be unreaped
   * before it believes what `ps` says about the child's pid.
   */
  test("ISC-272: a reaped child's pid is not a launch record, however confidently ps answers", async () => {
    try {
      const rec = await withStubPs(STUB_PS_ANSWERS_FOR_ANYONE, async () =>
        processLauncher.launchDetached(await spec(["/bin/sh", "-c", "exit 0"])),
      );
      // The sentinels every reader already refuses — NOT the stranger's triple.
      expect(rec.pgid).toBe(-1);
      expect(rec.started).toBe("");
      // And the record is unusable in exactly the way a refusal requires: a
      // non-positive group is `unrecorded`, never a group to signal.
      expect(await confirmGroup({ pid: rec.pid, started: "x" }, rec.pgid, realProcessOps)).toEqual({
        ok: false,
        why: "unrecorded",
      });
    } finally {
      await cleanup();
    }
    // One `sh`, two stub `ps` inside `launchDetached`. `confirmGroup` refuses
    // on `recorded <= 0` before it spawns anything. Three.
  }, cliBudget(3));

  /**
   * THE MUTATION PROBE FOR THE LEADER CONDITION.
   *
   * The child is alive and unreaped, so the reaped-child guard passes; the only
   * thing wrong is that `ps` puts the pid in group 1 rather than in its own.
   * That is what a `ps` answering about someone else looks like, and it is also
   * what a detach that did not take looks like.
   *
   * The old launcher wrote `1` into the launch record. `down` would then refuse
   * it — `confirmGroup` compares against the OS — but the refusal would be
   * blamed on a stale state file rather than on the launcher, and the run would
   * be unstoppable without `--force-identity` for a reason nothing recorded.
   * Refusing at the WRITE is what makes "recorded when the supervisor launched"
   * a measured fact rather than a field name.
   *
   * Fails if: the launcher records a group it did not confirm the child leads.
   */
  test("ISC-272: a pgid the launched child does not lead is never recorded", async () => {
    try {
      /*
       * `/bin/sleep`, ABSOLUTE, and that is an assertion this test rests on
       * rather than a style preference. `withStubPs` replaces PATH with a
       * directory holding nothing but `ps`, and the child inherits it — so a
       * bare `sleep 30` is NOT FOUND, the shell exits instantly, and the
       * launcher refuses on the REAPED-CHILD guard instead of the leader
       * condition. Measured: with `sh -c "sleep 30"` this test passed with the
       * leader condition DELETED, testing a guard it was not written for. The
       * child has to be genuinely alive for the refusal to be about the group.
       */
      const rec = await withStubPs(STUB_PS_FOREIGN_GROUP, async () =>
        processLauncher.launchDetached(await spec(["/bin/sleep", "30"])),
      );
      groups.push(rec.pid);
      /*
       * THE PRECONDITION, asserted rather than assumed — this is the line that
       * keeps the refusal below from being satisfiable by the wrong guard. The
       * stub answers affirmatively for any pid, so a non-null reading here
       * means the launcher had a live child and a usable identity, and the
       * ONLY thing left for it to refuse on is the group.
       */
      expect(await processStartTime(rec.pid)).not.toBeNull();
      expect(rec.pgid).not.toBe(1);
      expect(rec.pgid).toBe(-1);
      expect(rec.started).toBe("");
    } finally {
      await cleanup();
    }
    // One `sleep`, two stub `ps` inside `launchDetached`, one `ps -o lstart=`
    // for the precondition, one `ps -o pid= -g` in cleanup. Five.
  }, cliBudget(5));
});

// ---------------------------------------------------------------------------
// The ladder addresses (pid, started), never pid alone (ISC-191)
// ---------------------------------------------------------------------------

describe("the kill ladder compares the recorded start time at every rung (ISC-191)", () => {
  /**
   * THE ISC-191 PROBE, stated as the criterion's own mutation test: drop the
   * `started` comparison at any rung and this goes red.
   *
   * A REAL, LIVE process group — the same shape a supervisor has, leader plus a
   * member — with a recorded start time that does NOT match the OS. That is
   * exactly the world after a reboot: `down` resolves the latest run, the run
   * is stale, and the pids in it now belong to whatever the machine started
   * since. The ladder must refuse at rung 0 and signal nothing.
   *
   * THE ASSERTION IS THE NEGATIVE, and it has to be. "The ladder returned
   * `already_gone`" is satisfiable by a ladder that signalled the group first
   * and noticed afterwards, so the load-bearing assertion is that all of the
   * group's members are STILL THERE. A liveness-only check — `startTime(pid)
   * !== null`, which is what this ladder used before ISC-191 — passes rung 0
   * here and SIGKILLs three processes the run never launched.
   *
   * Fails if: `sameIdentity` stops comparing `started`, at rung 0 or at any
   * later rung.
   */
  test("ISC-191: a recorded start time that disagrees with the OS spares the whole group", async () => {
    try {
      const rec = await processLauncher.launchDetached(await spec(["/bin/sh", "-c", "sleep 30 & sleep 30"]));
      groups.push(rec.pid);
      expect(rec.pgid).toBe(rec.pid);

      // The group has to have members, or "the group survived" is a
      // restatement of "the leader survived".
      let before: number[] = [];
      for (let i = 0; i < 40; i++) {
        before = await groupMembers(rec.pid);
        if (before.length >= 2) break;
        await new Promise((r) => setTimeout(r, 25));
      }
      expect(before.length).toBeGreaterThanOrEqual(2);

      /*
       * The same pid, a DIFFERENT recorded identity. Not `""` and not a
       * malformed string: a well-formed token in the pinned rendering that
       * simply belongs to another process, which is the only version of this
       * that the format checks cannot catch for us.
       */
      const outcome = await runKillLadder({
        target: { pid: rec.pid, started: `${IDENTITY_FORMAT} Thu  1 Jan 00:00:00 2001` },
        pgid: rec.pgid,
        // Short REAL milliseconds. A guard whose broken state is "the
        // condition is never true" can make a ladder wait out its full grace
        // at every rung rather than fail, so the graces are small enough that
        // a mutation reddens the assertion instead of exhausting the runner.
        termGraceMs: 300,
        killGraceMs: 300,
        pollMs: 25,
      });
      expect(outcome).toBe("already_gone");

      const after = await groupMembers(rec.pid);
      // Every member, not just the leader: the ladder was handed a group, so
      // an unguarded rung reaches all of them.
      for (const pid of before) expect(after).toContain(pid);
    } finally {
      await cleanup();
    }
    // One `sh`; two `ps` inside `launchDetached`; up to two `ps -o pid= -g`
    // polls before the group fills; one `ps -o lstart=` at rung 0 (the ladder
    // refuses there and spawns nothing further); one closing `ps -o pid= -g`.
    // Seven.
  }, cliBudget(7));
});
