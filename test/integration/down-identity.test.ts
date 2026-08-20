/**
 * `down` signals a RECORDED identity, never a bare pid (ISC-191), and refuses
 * — visibly — when it has no recorded identity it can trust.
 *
 * `safety/kill.ts` says in its header that the `(pid, started)` pair is
 * "re-read from the OS and compared at EVERY rung", and named `down`'s
 * quiesce as one of its callers. `down` never imported it. It ran an inline
 * ladder over a bare `process.kill`, gated only on
 * `processStartTime(pid) !== null` — liveness, not identity — so a run
 * directory whose supervisor died before `down` ever ran would happily
 * SIGTERM and then SIGKILL whatever inherited the number.
 *
 * That is not a hypothetical. `down-prune.test.ts`'s own fixture carries the
 * scar: its first revision recorded `process.pid`, and `down` sent SIGTERM to
 * the test runner's process group and killed ITSELF five seconds in. The
 * fixture was changed to pick a pid that is not a group leader so the signal
 * would raise ESRCH — the hazard was routed around, not removed.
 *
 * THREE CLASSES OF FACT, and the whole file exists to keep them apart:
 *
 *  1. Nothing holds the pid          -> `already_gone`, `stopped: true`. The
 *                                       only one of the three that is a
 *                                       success.
 *  2. Something holds the pid and it -> `identity_mismatch`, `stopped: false`.
 *     is provably not ours              A refusal to act, not a success.
 *  3. Something holds the pid and we -> `identity_unrecorded` /
 *     cannot tell                       `identity_legacy_format`,
 *                                       `stopped: false`. Also a refusal.
 *
 * All three were reported as (1). That is what made a LIVE supervisor read as
 * stopped at exit 0 — and, because the `--prune` gate refuses only when
 * `stopped` is false, what made a live worker's checkout PRUNABLE. The
 * `--prune` case is asserted at the bottom of this file, because it is the
 * data-loss half rather than a reporting nicety.
 *
 * Most tests here assert a NEGATIVE: a process that is alive before `down` is
 * still alive after it. Only a recorded survival can prove a signal was not
 * delivered, which is the same reason `test/unit/kill.test.ts` leans on its
 * empty `signals` array.
 *
 * Every stand-in is a real `sleep` child of this test process, reaped in
 * `afterAll`, so nothing here leaks a process or depends on a pid this suite
 * does not own.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { IDENTITY_FORMAT, isPinnedIdentity, processStartTime } from "../../src/run/registry.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import { cliBudget } from "../support/budget.ts";

const ROOT = join(new URL("../../", import.meta.url).pathname);
const CLI = join(ROOT, "src/cli/index.ts");
const CAPTURE = join(ROOT, "test/fixtures/capture-identity.ts");

/**
 * A recorded identity in the CURRENT format that no live process can hold.
 *
 * It carries the `utc1 ` tag deliberately, so it exercises
 * `identity_mismatch` — "a stranger holds this pid" — rather than the
 * legacy-format path. The year is the discriminator; a bare sentinel with no
 * tag reads as a pre-pin recording and takes a different branch, which is the
 * point of `LEGACY_START` below.
 */
const FOREIGN_START = `${IDENTITY_FORMAT} Thu Aug 20 00:00:00 1999`;

/**
 * A recorded identity in the shape a PRE-PIN build wrote: `ps -o lstart=`
 * verbatim, in whatever timezone and locale the launcher happened to have,
 * with no format tag. This is what every run directory on disk contains at
 * the moment of upgrade.
 */
const LEGACY_START = "Thu 20 Aug 06:44:42 2026";

/**
 * `down`'s wall-clock ladder, which `cliBudget` does not model.
 *
 * `cliBudget(n)` prices SPAWNS — transpile plus work — and scales them for
 * machine contention. The ladder's waits are neither: `GRACEFUL_WAIT_MS`
 * (5000) plus two `TERM_WAIT_MS` (2000 each) are fixed sleeps in `down.ts`
 * that cost the same 9 s on an idle box as on a loaded one. They ADD to a
 * budget rather than multiply it, so any test that actually climbs the ladder
 * gets this on top. Tests that refuse, or that find nothing on the pid, never
 * reach the ladder and do not pay it.
 */
const LADDER_FIXED_WAIT_MS = 9_000;

const bases: string[] = [];
const children: Array<{ pid: number; kill: (sig?: number | NodeJS.Signals) => void }> = [];

afterAll(async () => {
  for (const c of children) {
    try {
      c.kill("SIGKILL");
    } catch {
      // Already exited — the desired state.
    }
  }
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

/**
 * A live process that `down` must not touch.
 *
 * `sleep` is spawned WITHOUT being made a group leader, exactly as
 * `down-prune.test.ts` does, so that even a regression cannot escalate
 * beyond this one pid: a stray `kill(-pid, …)` raises ESRCH instead of
 * reaching this test runner's group. The daemon rung signals a BARE pid,
 * which is what makes the negative assertion below load-bearing rather than
 * accidentally satisfied.
 */
function bystander(): { pid: number } {
  const child = Bun.spawn(["sleep", "30"], { stdout: "ignore", stderr: "ignore" });
  children.push(child);
  return { pid: child.pid };
}

async function rig(): Promise<{ root: string; runId: string; run: ReturnType<typeof runPaths> }> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-downid-"));
  bases.push(base);
  const root = join(base, "runs");
  const runId = "2026-08-19T00-00-00Z-idnt";
  const run = runPaths(runId, root);
  await mkdir(run.workersDir, { recursive: true });
  return { root, runId, run };
}

async function down(
  root: string,
  runId: string,
  args: string[] = [],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, "down", "--run", runId, "--json", ...args], {
    env: { PATH: process.env["PATH"] ?? "", PIFLEET_RUNS_DIR: root },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ]);
  return { code, stdout, stderr };
}

const parse = (stdout: string): Record<string, unknown> =>
  JSON.parse(stdout.trim().split("\n").pop() ?? "{}") as Record<string, unknown>;

/** Plant a one-worker run whose `state.json` names `pid`. */
async function plantWorker(
  run: ReturnType<typeof runPaths>,
  runId: string,
  id: string,
  pid: number,
  procStarted?: string,
): Promise<void> {
  const wp = workerPaths(run, id);
  await mkdir(wp.dir, { recursive: true });
  await writeWorkerState(
    wp,
    initialWorkerState({
      worker: id,
      runId,
      pid,
      pgid: pid,
      startedAt: new Date().toISOString(),
      // Omitted by default, which is the pre-`proc_started` state file every
      // refusal test in this file depends on: absent records as `""`, and
      // `isPinnedIdentity("")` is false, so those tests keep asserting a
      // refusal for the reason they always did.
      ...(procStarted === undefined ? {} : { procStarted }),
    }),
  );
}

/** Plant a registry naming `id` at `pid` with the given recorded identity. */
async function plantRegistry(
  run: ReturnType<typeof runPaths>,
  runId: string,
  entries: Array<{ id: string; pid: number; started: string }>,
): Promise<void> {
  await writeFile(
    run.registryJson,
    JSON.stringify({
      schema: "pifleet.registry/v1",
      run_id: runId,
      daemon: { pid: 0, started: FOREIGN_START },
      workers: Object.fromEntries(
        entries.map((e) => [
          e.id,
          {
            worker: e.id,
            pid: e.pid,
            pgid: e.pid,
            started: e.started,
            registered_at: new Date().toISOString(),
          },
        ]),
      ),
    }),
    "utf8",
  );
}

// ---------------------------------------------------------------------------
// The rendering itself (the defect the rest of this file rests on)
// ---------------------------------------------------------------------------

describe("a recorded identity is a function of the process, not of the recorder", () => {
  /**
   * THE regression test for the timezone/locale defect.
   *
   * `ps -o lstart=` RENDERS a timestamp from the calling process's own
   * environment. Measured on one live pid at one instant, before the fix:
   *
   *   TZ=UTC               "Thu 20 Aug 06:44:42 2026"
   *   TZ=America/Halifax   "Thu 20 Aug 03:39:12 2026"
   *   LC_TIME=de_DE.UTF-8  "Do. 20 Aug. 00:39:12 2026"
   *
   * An identity is captured by the LAUNCHER and compared by the OPERATOR, and
   * those are routinely different environments — `up` locally and `down` over
   * SSH (sshd forwards `LC_TIME` under its default `AcceptEnv LANG LC_*`),
   * `up` from launchd with no `TZ` and `down` from a shell that sets one, a
   * containerised CLI against a host-launched daemon. Every one of them made
   * a LIVE supervisor compare unequal to its own recorded identity, which the
   * kill path reads as "gone".
   *
   * Both captures run in real child processes with real environments. An
   * in-process `process.env.TZ` mutation does NOT reach an
   * inherited-environment child — measured, and it makes even the unpinned
   * renderings compare equal, so a test written that way would pass with the
   * fix reverted.
   *
   * Fails if: the `TZ`/`LC_ALL` pin in `processStartTime` is removed — the
   * two captures diverge by the UTC offset and by field order.
   */
  test("the same live pid captured under different TZ and locale yields identical bytes", async () => {
    const victim = bystander();

    const capture = async (env: Record<string, string>): Promise<string> => {
      const p = Bun.spawn([process.execPath, CAPTURE, String(victim.pid)], {
        env: { PATH: process.env["PATH"] ?? "", ...env },
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, , code] = await Promise.all([
        new Response(p.stdout).text(),
        new Response(p.stderr).text(),
        p.exited,
      ]);
      expect(code).toBe(0);
      return out.trim();
    };

    const launcher = await capture({ TZ: "UTC", LC_ALL: "en_US.UTF-8" });
    const operator = await capture({ TZ: "America/Halifax", LC_ALL: "en_US.UTF-8" });
    const german = await capture({ TZ: "Europe/Berlin", LC_TIME: "de_DE.UTF-8" });

    expect(launcher).not.toBe("");
    expect(launcher).toBe(operator);
    expect(launcher).toBe(german);
    // …and it is self-describing, which is what makes the format change
    // detectable rather than silent on the first run after an upgrade.
    expect(isPinnedIdentity(launcher)).toBe(true);
    // Two spawns of the capture fixture, plus one more for the German
    // rendering: three `bun` subprocess invocations, charged at the CLI rate.
    // No ladder runs here, so no fixed wait is added.
  }, cliBudget(3));

  /**
   * The tag is what tells a pre-pin recording apart from a current one, and
   * the migration policy in `down.ts` rests entirely on that distinction
   * being decidable. Fails if: the tag is dropped, or a legacy rendering
   * could ever be mistaken for a tagged one.
   */
  test("a pre-pin recording is recognisable as one", async () => {
    const victim = bystander();
    const current = await processStartTime(victim.pid);
    expect(current).not.toBeNull();
    expect(isPinnedIdentity(current!)).toBe(true);
    expect(isPinnedIdentity(LEGACY_START)).toBe(false);
    // `""` is the capture-failed sentinel both writers persist; it is not a
    // recording and must never read as a comparable one.
    expect(isPinnedIdentity("")).toBe(false);
    // One `ps` spawn inside `processStartTime`, charged at the CLI rate —
    // deliberately conservative, per budget.ts's "charge every spawn the
    // expensive rate" rule. No ladder, so no fixed wait.
  }, cliBudget(1));
});

// ---------------------------------------------------------------------------
// Rung 0: a recorded identity that disagrees
// ---------------------------------------------------------------------------

describe("down signals only a process whose recorded identity still matches", () => {
  /**
   * THE regression test for the unguarded daemon rung.
   *
   * `daemon.pid` records `{pid, started}` — both fields, written together by
   * `startRegistryDaemon`. `down` parsed the file, took the pid, threw the
   * identity away and signalled the number. Here the recorded identity does
   * not match the process currently holding that pid, which is precisely the
   * post-reboot stale-run-directory case an operator reaches by running a
   * bare `pifleet down`.
   *
   * The daemon rung passes `pgid: null`, so `signalIfSame` addresses
   * `target.pid` DIRECTLY — no group indirection to raise ESRCH by luck.
   * That is what makes the survival assertion below load-bearing.
   *
   * Fails if: the daemon rung stops comparing `started` before signalling —
   * the bystander is SIGTERMed and is gone when the assertion reads it back.
   */
  test("a daemon pid whose recorded start time no longer matches is never signalled", async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    expect(await processStartTime(victim.pid)).not.toBeNull(); // the fixture is real

    await writeFile(run.daemonPid, JSON.stringify({ pid: victim.pid, started: FOREIGN_START }), "utf8");

    const r = await down(root, runId);
    expect(r.code, `stderr: ${r.stderr.slice(0, 400)}`).toBe(EXIT.SUCCESS);
    expect(parse(r.stdout)).toMatchObject({ clean: true });
    // The refusal is CARRIED, not swallowed. It does not fail the command —
    // the daemon holds no checkout, so no prune decision rests on it — but a
    // refusal that appears nowhere in the output is indistinguishable from a
    // daemon that was never running.
    expect(parse(r.stdout)).toMatchObject({ daemon: { stopped: false, how: "identity_mismatch" } });

    // The whole point: it is still there.
    expect(await processStartTime(victim.pid)).not.toBeNull();
    // One `down` spawn, plus two `ps` spawns from the `processStartTime`
    // assertions either side of it: three. No ladder runs (the anchor refuses
    // before Phase 1), so no fixed wait is added.
  }, cliBudget(3));

  /**
   * The same discipline on the worker rung, read off the registry — the one
   * place a supervisor's `(pid, started)` is actually recorded at launch
   * (`register_worker`, whose own comment says "identity is (pid, start-time)
   * so pid reuse cannot resurrect us later").
   *
   * The assertion is on the REPORT as well as on the bystander's survival,
   * because this rung addresses `-pgid` and the bystander is not a group
   * leader: an unguarded signal would raise ESRCH and the process would
   * survive for the wrong reason.
   *
   * `stopped: false` and a non-zero exit, NOT `stopped: true, already_gone`,
   * which is what this asserted until the reporting was fixed. A refusal
   * reported as a success is what made the `--prune` gate — which acts only
   * on `stopped` — classify a live worker as prunable. The earlier assertion
   * pinned the bug in place.
   *
   * Fails if: the worker rung stops consulting the registry-recorded
   * identity — `how` becomes "sigkill" and the command climbs a ladder
   * against a stranger — or if an anchor refusal goes back to reporting
   * itself as a clean stop.
   */
  test("a worker whose registry-recorded start time no longer matches is refused, visibly", async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    await plantWorker(run, runId, "eng-1", victim.pid);
    await plantRegistry(run, runId, [{ id: "eng-1", pid: victim.pid, started: FOREIGN_START }]);

    const r = await down(root, runId);
    expect(r.code).toBe(EXIT.WORKER_DIED);
    expect(parse(r.stdout)).toMatchObject({
      clean: false,
      workers: [{ id: "eng-1", stopped: false, how: "identity_mismatch" }],
    });
    // The operator is told what to do about it, on stderr, by name.
    expect(r.stderr).toContain("--force-identity");
    expect(await processStartTime(victim.pid)).not.toBeNull();
    // One `down` spawn plus one `ps` spawn: two. No ladder — refused at the
    // anchor — so no fixed wait.
  }, cliBudget(2));
});

// ---------------------------------------------------------------------------
// An identity that cannot be compared at all
// ---------------------------------------------------------------------------

describe("an unverifiable identity refuses rather than relaxes", () => {
  /**
   * THE regression test for the empty-string clause.
   *
   * `anchorIdentity` read `recorded !== "" && recorded !== current` — so an
   * empty recorded identity satisfied the gate and fell through to the
   * rung-0 self-anchor. `""` is not neutral: it is exactly what BOTH writers
   * persist when their own capture failed —
   * `(await processStartTime(process.pid)) ?? ""` in `startRegistryDaemon`
   * and in `supervisor/index.ts` — and `RegistryWorkerSchema.started` is a
   * bare `z.string()`, so a truncated or hand-edited file yields it too.
   *
   * Measured on unmutated pre-fix code, with a live `sleep` recorded as
   * `{"pid":N,"started":""}`: `down` exited 0, printed `clean: true`, and the
   * process was DEAD afterwards. On the daemon rung `signalGuarded` passes
   * `pgid: null`, so `signalIfSame` addressed `target.pid` — a bare pid, the
   * literal thing ISC-191 forbids.
   *
   * Fails if: `""` is treated as "no constraint" again — the bystander is
   * killed on a bare pid and this reads back gone.
   */
  test('an empty recorded identity ("" — capture failed) is never signalled', async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    await writeFile(run.daemonPid, JSON.stringify({ pid: victim.pid, started: "" }), "utf8");

    const r = await down(root, runId);
    expect(parse(r.stdout)).toMatchObject({
      daemon: { stopped: false, how: "identity_unrecorded" },
    });
    expect(await processStartTime(victim.pid)).not.toBeNull();
    // One `down` spawn plus one `ps` spawn: two. No ladder.
  }, cliBudget(2));

  /**
   * The absent case, which the empty case collapses to. A `daemon.pid`
   * written before the field existed has no `started` at all, and it must
   * take the same fail-closed branch — two states meaning the same thing must
   * not have two behaviours.
   *
   * Fails if: an absent identity relaxes to the self-anchor.
   */
  test("an absent recorded identity is never signalled either", async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    await writeFile(run.daemonPid, JSON.stringify({ pid: victim.pid }), "utf8");

    const r = await down(root, runId);
    expect(parse(r.stdout)).toMatchObject({
      daemon: { stopped: false, how: "identity_unrecorded" },
    });
    expect(await processStartTime(victim.pid)).not.toBeNull();
    // One `down` spawn plus one `ps` spawn: two. No ladder.
  }, cliBudget(2));

  /**
   * A worker with NO registry entry — ISC-272's original case. Registration
   * is `{optional: true}`, so a daemon that never came up leaves nothing
   * recorded, and the anchor used to fall back to whatever held the pid.
   *
   * Fails if: a worker missing from the registry goes back to being laddered
   * against whatever holds its recorded pid.
   */
  test("a worker with no registry entry at all is refused, not laddered", async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    await plantWorker(run, runId, "eng-1", victim.pid);
    // No registry.json written at all.

    const r = await down(root, runId);
    expect(r.code).toBe(EXIT.WORKER_DIED);
    expect(parse(r.stdout)).toMatchObject({
      workers: [{ id: "eng-1", stopped: false, how: "identity_unrecorded" }],
    });
    expect(await processStartTime(victim.pid)).not.toBeNull();
    // One `down` spawn plus one `ps` spawn: two. No ladder.
  }, cliBudget(2));

  /**
   * The half of the same hole ISC-272 did not name: a registry entry that
   * EXISTS but records a different pid than `state.json` — supervisor
   * relaunched, or one of the two files stale. `down` uses the entry only
   * when `recorded.pid === state.pid`, so this silently took the same weak
   * anchor as a worker with no entry at all, untested and unnamed.
   *
   * The registry here names the same worker at a pid that is NOT the one
   * `state.json` gives, so the entry is real and simply does not describe
   * this process.
   *
   * Fails if: a pid-disagreeing registry entry relaxes to the self-anchor.
   */
  /**
   * The daemon-less run, which is the case the registry-only anchor could not
   * serve and the one that made this branch red.
   *
   * `supervisor/index.ts` registers `{ optional: true }` and says why in its
   * own comment — "The supervisor must also work alone (integration tests,
   * daemon crash)". So `registry.json` is legitimately absent for a whole
   * class of runs, and anchoring only on it meant `down` answered
   * `identity_unrecorded` and left every one of those supervisors running.
   * That is not a hypothetical: it is `test/e2e/lifecycle.test.ts`'s happy
   * path, which asserts `down` exits 0 and observed EXIT.WORKER_DIED (6).
   *
   * The identity was never actually unknown. The supervisor reads it at launch
   * to send to the registry; it simply had nowhere daemon-independent to write
   * it down. `state.proc_started` is that place, and this test is the probe
   * that it is consulted.
   *
   * Fails if: the state file's self-recorded identity is ignored, or if it is
   * accepted without being compared (plant a foreign value and the sibling
   * test below still has to refuse).
   */
  test("a daemon-less run whose supervisor recorded its own identity is stopped", async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    // Exactly what a live supervisor writes: its OWN reading, in the pinned
    // rendering, for the pid its state file names.
    const self = await processStartTime(victim.pid);
    expect(self).not.toBeNull();
    await plantWorker(run, runId, "eng-1", victim.pid, self!);
    // Still no registry.json — that is the whole point.

    const r = await down(root, runId);
    /**
     * The assertion is on the VERDICT, for the reason the `--force-identity`
     * test states: this bystander is spawned as a non-group-leader so a stray
     * `kill(-pid, …)` raises ESRCH, and it therefore SURVIVES the ladder by
     * construction. `how` reaching "sigkill" is the whole claim — it means the
     * anchor RESOLVED and the ladder was entered, which is exactly what
     * `identity_unrecorded` prevented before `proc_started` existed.
     *
     * `forced_identity` must be absent: this climbed on a real recorded
     * identity, not on the override.
     */
    const report = parse(r.stdout) as { workers: Array<Record<string, unknown>> };
    expect(report.workers[0]).toMatchObject({ id: "eng-1", how: "sigkill" });
    expect(report.workers[0]).not.toHaveProperty("forced_identity");
    expect(report.workers[0]).not.toMatchObject({ how: "identity_unrecorded" });
  }, cliBudget(2) + LADDER_FIXED_WAIT_MS);

  /**
   * The guard on the test above: a self-recorded identity is still COMPARED,
   * so a state file naming a pid it does not describe refuses exactly as an
   * unrecorded one does. Without this, "consult `proc_started`" could be
   * satisfied by trusting it, which is the fail-open wearing the fix's
   * clothes.
   *
   * Fails if: `proc_started` is treated as permission to signal rather than as
   * an anchor to check.
   */
  test("a self-recorded identity that does not match the pid is refused", async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    await plantWorker(run, runId, "eng-1", victim.pid, `${IDENTITY_FORMAT} Thu Jan  1 00:00:00 1970`);

    const r = await down(root, runId);
    expect(r.code).toBe(EXIT.WORKER_DIED);
    expect(parse(r.stdout)).toMatchObject({
      workers: [{ id: "eng-1", stopped: false, how: "identity_mismatch" }],
    });
    expect(await processStartTime(victim.pid)).not.toBeNull();
  }, cliBudget(2));

  test("a registry entry whose pid disagrees with state.json is refused too", async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    const other = bystander();
    await plantWorker(run, runId, "eng-1", victim.pid);
    // A perfectly well-formed, CURRENT-format entry — for the wrong process.
    const started = await processStartTime(other.pid);
    expect(started).not.toBeNull();
    await plantRegistry(run, runId, [{ id: "eng-1", pid: other.pid, started: started! }]);

    const r = await down(root, runId);
    expect(r.code).toBe(EXIT.WORKER_DIED);
    expect(parse(r.stdout)).toMatchObject({
      workers: [{ id: "eng-1", stopped: false, how: "identity_unrecorded" }],
    });
    // Neither process is touched: not the one `state.json` names, and not the
    // one the registry names.
    expect(await processStartTime(victim.pid)).not.toBeNull();
    expect(await processStartTime(other.pid)).not.toBeNull();
    // One `down` spawn plus three `ps` spawns (one to build the fixture, two
    // to read the survivors back): four. No ladder.
  }, cliBudget(4));

  /**
   * THE migration test. Every `started` on disk at the moment of upgrade was
   * written before the rendering was pinned, and pinning changes the bytes —
   * even on a machine already in UTC, because `LC_ALL=C` also reorders the
   * fields. So the first `down` after an upgrade meets a value it cannot
   * compare, for every worker at once.
   *
   * The policy is to say so: `identity_legacy_format`, its OWN answer, not
   * `identity_mismatch`. Reporting it as a mismatch would assert something
   * false — that a stranger holds the pid — and would train the operator to
   * reach for `--force-identity` reflexively, on the one flag that re-opens
   * the fail-open.
   *
   * Fails if: a pre-pin recording is reported as a mismatch, silently
   * upgraded, or accepted.
   */
  test("a pre-pin recorded identity is refused as legacy, not as a mismatch", async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    await plantWorker(run, runId, "eng-1", victim.pid);
    await plantRegistry(run, runId, [{ id: "eng-1", pid: victim.pid, started: LEGACY_START }]);

    const r = await down(root, runId);
    expect(r.code).toBe(EXIT.WORKER_DIED);
    expect(parse(r.stdout)).toMatchObject({
      workers: [{ id: "eng-1", stopped: false, how: "identity_legacy_format" }],
    });
    expect(await processStartTime(victim.pid)).not.toBeNull();
    // One `down` spawn plus one `ps` spawn: two. No ladder.
  }, cliBudget(2));
});

// ---------------------------------------------------------------------------
// The hatch
// ---------------------------------------------------------------------------

describe("--force-identity is the deliberate override, and only that", () => {
  /**
   * A refusal must never be a dead end: an operator upgrading mid-run has to
   * be able to stop the run. `--force-identity` restores the pre-fix weak
   * anchor — whatever holds the pid becomes the target, every LATER rung
   * still identity-checked.
   *
   * The bystander survives here for the ESRCH reason `down-prune.test.ts`
   * documents (its recorded pgid is not a group leader), which is why the
   * assertion is on the VERDICT: `how` reaching "sigkill" proves the ladder
   * was entered, which is the whole difference the flag makes.
   *
   * Fails if: the flag stops overriding, or starts overriding by default.
   */
  test("it climbs the ladder a bare `down` refused to start", async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    await plantWorker(run, runId, "eng-1", victim.pid);
    await plantRegistry(run, runId, [{ id: "eng-1", pid: victim.pid, started: LEGACY_START }]);

    const refused = await down(root, runId);
    expect(parse(refused.stdout)).toMatchObject({
      workers: [{ id: "eng-1", stopped: false, how: "identity_legacy_format" }],
    });

    const forced = await down(root, runId, ["--force-identity"]);
    expect(parse(forced.stdout)).toMatchObject({
      workers: [{ id: "eng-1", stopped: false, how: "sigkill", forced_identity: true }],
    });
    // Two `down` spawns. The second one CLIMBS — graceful 5 s, SIGTERM 2 s,
    // SIGKILL 2 s against a target that never dies — so the 9 s of fixed
    // waiting is added on top of the spawn budget, which does not model it.
  }, cliBudget(2) + LADDER_FIXED_WAIT_MS);
});

// ---------------------------------------------------------------------------
// The data-loss half (SRD §9.3)
// ---------------------------------------------------------------------------

describe("an unverifiable supervisor blocks its own prune", () => {
  /**
   * THE reason this is a data-loss fix and not a reporting fix.
   *
   * `--prune`'s §9.3 gate refuses a checkout only when `stopped` is false.
   * An anchor refusal reported as `stopped: true, already_gone` therefore
   * classed a LIVE-but-unverifiable worker as PRUNABLE, and `--prune`
   * deleted the checkout of a container that was still writing — measured end
   * to end against the pre-fix build, with a real clone and a real live
   * process: exit 0, `clean: true`, `pruned: true`, directory gone.
   *
   * The worker here has no registry entry, so the anchor refuses; the process
   * is real and alive. The checkout must survive, and the exit code must say
   * something was kept.
   *
   * The refusal REASON is asserted too, and asserted to differ from the
   * survived-the-ladder wording: no ladder ran, and only one of the two
   * refusals has `--force-identity` as its answer.
   *
   * Fails if: an anchor refusal ever reports `stopped: true` again — the
   * checkout is deleted and `pathExists` reads false.
   */
  test("a live worker with no recorded identity keeps its checkout", async () => {
    const { root, runId, run } = await rig();
    const victim = bystander();
    await plantWorker(run, runId, "eng-1", victim.pid);

    // A recorded checkout under the parent repo, which is all the prune gate
    // needs to consider it. It is never reached, which is the assertion.
    const repo = join(await mkdtemp(join(tmpdir(), "pifleet-downid-repo-")), "repo");
    bases.push(repo);
    const checkout = join(repo, ".worktrees", "eng-1");
    await mkdir(checkout, { recursive: true });
    await writeFile(join(checkout, "PRECIOUS.txt"), "a live container is still writing here\n", "utf8");
    await writeFile(
      run.runJson,
      JSON.stringify({
        schema: "pifleet.run/v1",
        run_id: runId,
        repo,
        worktrees: [
          {
            workerId: "eng-1",
            path: checkout,
            branch: "wk/eng-1",
            baseSha: "0".repeat(40),
            remoteName: "wk-eng-1",
            baselineStatus: "",
            baselineTree: "",
          },
        ],
      }),
      "utf8",
    );

    const r = await down(root, runId, ["--prune"]);
    expect(r.code).not.toBe(EXIT.SUCCESS);
    const out = parse(r.stdout);
    expect(out).toMatchObject({
      workers: [{ id: "eng-1", stopped: false, how: "identity_unrecorded" }],
      pruned: [{ workerId: "eng-1", pruned: false }],
    });
    const reason = String((out["pruned"] as Array<Record<string, unknown>>)[0]!["reason"]);
    expect(reason).toContain("could not be identified");
    expect(reason).toContain("--force-identity");
    // Not the ladder's words: no ladder ran, and saying so would be false.
    expect(reason).not.toContain("survived the kill ladder");

    // The file is still on disk. This is the assertion the whole finding is
    // about.
    expect(await Bun.file(join(checkout, "PRECIOUS.txt")).exists()).toBe(true);
    expect(await processStartTime(victim.pid)).not.toBeNull();
    // One `down` spawn plus one `ps` spawn: two. No ladder — refused at the
    // anchor before Phase 1.
  }, cliBudget(2));
});
