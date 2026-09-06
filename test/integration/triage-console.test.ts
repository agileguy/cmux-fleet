/**
 * `scripts/triage` — the fourth console, EXECUTED. SRD-TRIAGE-CONSOLE §12's
 * *"The console and the actor"* block; §13 task 4.5.
 *
 * ## The gap this file was written to close, named precisely
 *
 * Round 6 landed `scripts/triage` and pinned it with SOURCE-STRUCTURE probes
 * only. `test/unit/console-restart.test.ts:471` and
 * `test/unit/fresh-dispatch.test.ts:705` read the file's TEXT and assert that
 * `quiesce` appears as a dep property and not as a call above
 * `recreateThenDispatch(`; `test/unit/fresh-dispatch.test.ts:392` asserts the
 * ORDERING behaviourally, but against `src/run/fresh-dispatch.ts` with fake deps
 * and with no console in the picture at all. The engineer who wrote the script
 * said what was missing in the same words §12 uses: *"No live run of
 * `scripts/triage` past `--dry-run`. I never started an actor or opened a
 * workspace."*
 *
 * So nothing had ever run this script's `--restart` branch. This file does.
 *
 * ## HOW IT RUNS WITHOUT A CONSOLE, AN ACTOR, OR THE OPERATOR'S STATE
 *
 * Three seams, and each is a stub of something the script talks to rather than a
 * copy of something the script does:
 *
 *  1. **`PIFLEET_RUNS_DIR`** points the whole process tree at a per-test temp
 *     directory. `relayRecordPath` and friends derive from `dirname(runsRoot())`
 *     (`console-relay.ts:127`), and the `pifleet status` subprocesses the script
 *     spawns inherit the variable, so the actor record, the log, the lock and the
 *     run tree are all inside the temp dir. **ISC-614 is why this is asserted
 *     rather than assumed**: round 5's battery ran against an isolated copy of
 *     the tree, correctly, and still left two fixture records in the operator's
 *     real `~/.pifleet`, because that directory is keyed off `$HOME` and not off
 *     the checkout. `refusesToRunAgainstTheOperatorsHome` below is the guard, and
 *     it runs before every spawn.
 *  2. **A `cmux` stub on `PATH`.** `cmuxReachable` is one `cmux ping`
 *     (`operations.ts:420-423`), and the `--restart` branch sits below it. The
 *     stub answers `ping` with exit 0 and REFUSES every other verb with exit 1,
 *     so a test that accidentally reached a real workspace operation fails loudly
 *     instead of quietly doing nothing. `test/integration/backend-selection.test.ts:85`
 *     is the precedent; that one's `ping` fails on purpose, this one's succeeds.
 *  3. **A fabricated run tree**, so `pifleet status --all --json` reports a
 *     worker holding a task. `run.json` needs only to exist; `state.json` is
 *     built by `initialWorkerState` rather than hand-spelled, on
 *     `status-live-run.test.ts:57`'s recorded lesson. `registry.json` is
 *     deliberately absent so liveness falls to `notDeadAndRunning`, which is
 *     satisfiable with a pid this process can be sure of.
 *
 * **No real cmux workspace is opened and no real actor is started.** The "actor"
 * every fixture below points at is a `sleep` this file spawned and kills, which
 * makes *"the record still names a LIVE pid"* an assertion about a process whose
 * life this test controls — and makes a regression that signals it a red test
 * rather than a message on somebody's screen.
 *
 * ## WHAT THIS FILE DOES NOT REACH, stated rather than implied
 *
 *  - **The busy-worker refusal's own sentence.** `recreateThenDispatch`'s settle
 *    timeout is 20 minutes and `scripts/triage` passes no override, so the
 *    `busyRefusal` text arrives 20 minutes after the wait starts. This file
 *    asserts the half that ISC-572 is actually about — that the actor is STILL
 *    LIVE while the wait runs — and terminates the script. `busyRefusal`'s words
 *    are pinned against the module by `test/unit/fresh-dispatch.test.ts`.
 *  - **`--recreate`, `--no-actor`'s start path, and `restartConsolePane`.** All
 *    three tear something down or open a pane; the stub refuses them and this
 *    file does not drive them.
 *  - **`pifleet triage` and `--status`.** §13 Phase 6 and Phase 7. Not built.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, readdir, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, sep } from "node:path";

import { loadConfig, resolveWorker } from "../../src/config/load.ts";
import {
  DEFAULT_TRIAGE_WORKERS,
  TRIAGE_WORKSPACE,
  triagePanes,
} from "../../src/backends/cmux/operations-plan.ts";
import { TRIAGE_SPEC } from "../../src/backends/cmux/operations.ts";
import {
  readRelayStatus,
  relayLockPath,
  relayLogPath,
  relayRecordPath,
  servesConsole,
  writeRelayRecord,
  type RelayRecord,
} from "../../src/run/console-relay.ts";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import { processStartTime } from "../../src/safety/procstart.ts";
import { cliBudget } from "../support/budget.ts";
import { announceMissingHostDeps, hostHas } from "../support/host-deps.ts";

const REPO = new URL("../..", import.meta.url).pathname.replace(/\/$/, "");
/** The TRACKED config. The operator's `fleet.yaml` is gitignored — CI has none. */
const CONFIG = "fleet.example.yaml";

announceMissingHostDeps();
/**
 * The one host capability this file needs, and it is the one `host-deps.ts`
 * already describes as *"these tests write a stub onto PATH and run it"*.
 * `PIFLEET_REQUIRE_HOST_DEPS=1` turns the skip into a failure.
 */
const EXEC_TMP = hostHas("exec-tmpdir");

/** Every `sleep` this file spawned as a stand-in actor, killed at the end. */
const sleepers: Bun.Subprocess[] = [];
afterAll(() => {
  for (const s of sleepers) {
    try {
      s.kill("SIGKILL");
    } catch {
      // Already gone — which is what a test that asserted a stop wanted.
    }
  }
});

interface Rig {
  /** The temp `~/.pifleet` stand-in: the runs root's PARENT. */
  readonly stateDir: string;
  readonly runsRoot: string;
  readonly env: Record<string, string>;
}

/**
 * A hermetic state directory plus a `cmux` that answers only `ping`.
 *
 * The stub refuses every other verb rather than succeeding at it. A permissive
 * stub would let a test that accidentally reached `workspace create` pass while
 * doing nothing, which is the shape of failure this whole file exists to stop
 * being possible on this console.
 */
async function makeRig(label: string): Promise<Rig> {
  const stateDir = await mkdtemp(join(tmpdir(), `pf-triage-${label}-`));
  const runsRoot = join(stateDir, "runs");
  await mkdir(runsRoot, { recursive: true });

  const binDir = join(stateDir, "bin");
  await mkdir(binDir, { recursive: true });
  const stub = join(binDir, "cmux");
  await writeFile(
    stub,
    [
      "#!/bin/sh",
      '# Test stub. `ping` is the only verb this console may reach here; every',
      '# workspace operation is refused so an escape fails loudly.',
      'if [ "$1" = "ping" ]; then exit 0; fi',
      'echo "cmux stub: refusing \'$*\' — no test in triage-console.test.ts may open a workspace" >&2',
      "exit 1",
      "",
    ].join("\n"),
  );
  await chmod(stub, 0o755);

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PIFLEET_RUNS_DIR: runsRoot,
    PATH: `${binDir}${sep === "\\" ? ";" : ":"}${process.env["PATH"] ?? ""}`,
  };
  refusesToRunAgainstTheOperatorsHome(env);
  return { stateDir, runsRoot, env };
}

/**
 * ISC-614's guard, as code rather than as care.
 *
 * *"Tree isolation is not state isolation."* This console's record, log and lock
 * are keyed off `$HOME` unless `PIFLEET_RUNS_DIR` says otherwise, and
 * `--actor-stop` SIGNALS the pid in that record. A rig that leaked would not
 * write a stray file — it would send SIGTERM to the operator's live triage
 * actor. So the check is a throw at rig construction, before any spawn, and it
 * compares the DERIVED path rather than the variable: a typo'd variable name
 * leaves the variable set and the path unmoved.
 */
function refusesToRunAgainstTheOperatorsHome(env: Record<string, string>): void {
  const home = homedir();
  for (const path of [
    relayRecordPath("triage", env),
    relayLogPath("triage", env),
    relayLockPath("triage", env),
    relayRecordPath("review", env),
  ]) {
    if (path.startsWith(join(home, ".pifleet"))) {
      throw new Error(
        `this rig would write ${path}, which is the operator's own state directory. ` +
          `PIFLEET_RUNS_DIR is meant to move it and did not.`,
      );
    }
  }
}

/** Run `scripts/triage` to completion under a rig. */
async function triage(
  rig: Rig,
  args: readonly string[],
): Promise<{ code: number; out: string; err: string }> {
  const proc = Bun.spawn(["bun", "run", "scripts/triage", "--config", CONFIG, ...args], {
    cwd: REPO,
    env: rig.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const [out, err] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, out, err };
}

/**
 * A record naming a process that is genuinely alive — a `sleep` this file owns.
 *
 * `processStartTime` is read from the OS rather than invented, because
 * `readRelayStatus` compares it and an invented token makes the record
 * `unverifiable`, which is a DIFFERENT verdict with different behaviour
 * (`console-relay.ts:607`) and would silently change what every fixture below is
 * testing.
 */
async function plantActor(
  rig: Rig,
  console_: "triage" | "review",
  runId: string,
): Promise<{ pid: number; path: string }> {
  const sleeper = Bun.spawn(["sleep", "600"], { stdout: "ignore", stderr: "ignore" });
  sleepers.push(sleeper);
  const record: RelayRecord = {
    schema: "pifleet.consolerelay/v1",
    pid: sleeper.pid,
    started: (await processStartTime(sleeper.pid)) ?? "",
    console: console_,
    run_id: runId,
    pinned: null,
    workers: [...DEFAULT_TRIAGE_WORKERS],
    started_at: new Date().toISOString(),
    log_path: relayLogPath(console_, rig.env),
  };
  expect(record.started, "the OS would not name the stand-in actor's start time").not.toBe("");
  const path = relayRecordPath(console_, rig.env);
  await writeRelayRecord(path, record);
  expect((await readRelayStatus(path)).kind).toBe("live");
  return { pid: sleeper.pid, path };
}

/** A run tree in which `worker` is holding a task, and nothing else exists. */
async function plantBusyRun(rig: Rig, runId: string, worker: string): Promise<void> {
  const run = runPaths(runId, rig.runsRoot);
  await mkdir(run.workersDir, { recursive: true });
  // Existence is all `runIdsAscending` asks of it.
  await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }));
  const wp = workerPaths(run, worker);
  await mkdir(wp.dir, { recursive: true });
  const state = initialWorkerState({
    worker,
    runId,
    // The one pid a test can be sure is alive, and `registry.json` is absent so
    // liveness is `notDeadAndRunning` rather than a `ps` identity comparison.
    pid: process.pid,
    pgid: process.pid,
    startedAt: new Date().toISOString(),
  });
  await writeWorkerState(wp, { ...state, phase: "busy", task_id: "T-sweep-1" });
}

describe("--dry-run prints four panes and touches nothing", () => {
  /**
   * §12: *"`./scripts/triage --dry-run` prints four panes and touches nothing."*
   *
   * The panes are asserted BY NAME against `DEFAULT_TRIAGE_WORKERS` rather than
   * by counting four lines. A console that printed four panes for the wrong four
   * workers satisfies a count and is the exact defect
   * `test/integration/operations-console.test.ts` was written after: pane 1
   * brought up one worker and rendered another.
   */
  test.skipIf(!EXEC_TMP)(
    "the four seats, by name, in pane order",
    async () => {
      const rig = await makeRig("dry");
      const r = await triage(rig, ["--dry-run"]);
      expect(r.code).toBe(0);
      expect(r.out).toContain(`workspace: ${TRIAGE_WORKSPACE}`);

      const titles = [...r.out.matchAll(/^pane \d+ \((.+)\):$/gm)].map((m) => m[1]!);
      expect(titles).toEqual([...DEFAULT_TRIAGE_WORKERS]);
      expect(titles.length).toBe(4);
    },
    cliBudget(1),
  );

  /**
   * §12: *"**Anti: no decision lives in `scripts/triage`.** Probe: the script
   * imports its plan and its deps; assert the roster, the pane plan and the
   * cadence default are all `src/` exports."*
   *
   * Taken as an EXECUTED EQUIVALENCE rather than as a grep for import lines. The
   * plan is computed here from the `src/` export and every command the script
   * printed is asserted to be that plan's, verbatim. A script that imported
   * `triagePanes` and then edited its output — or reimplemented one pane inline —
   * passes an import grep and fails this.
   *
   * It also closes the hazard `operations-console.test.ts:150-168` records for
   * the other three consoles: `--dry-run` takes a THIRD call site into the plan
   * and a preview that disagrees with what the console runs *"is worse than no
   * preview, because it is consulted exactly when someone is trying to work out
   * what will happen"* — and on this console, which nobody watches, the preview
   * is how an operator inspects it at all.
   */
  test.skipIf(!EXEC_TMP)(
    "every printed command is the src/ plan's own, verbatim",
    async () => {
      const rig = await makeRig("plan");
      const r = await triage(rig, ["--dry-run"]);

      const planned = triagePanes({
        repoRoot: REPO,
        watchDir: REPO,
        configPath: CONFIG,
        tuiWorkers: [],
        workspaceName: TRIAGE_SPEC.name,
      });
      expect(planned.map((p) => p.title)).toEqual([...DEFAULT_TRIAGE_WORKERS]);
      for (const pane of planned) {
        expect(r.out, `${pane.title}'s command is not the plan's`).toContain(pane.command);
      }
    },
    cliBudget(1),
  );

  /**
   * *"Touches nothing"*, asserted against the STATE DIRECTORY rather than
   * reasoned about. `--dry-run` returns before the cmux probe, so nothing should
   * appear beside the runs root — no actor record, no log, no lock — and the runs
   * root should still be empty.
   *
   * This is also the arm that would catch a `--dry-run` that started an actor,
   * which is a thing a console script has done: `scripts/triage`'s own
   * `startActor` is idempotent precisely because *"run it again"* is the
   * supervision story, and an early call to it would be invisible to every
   * assertion about stdout.
   */
  test.skipIf(!EXEC_TMP)(
    "nothing appears in the state directory, by name",
    async () => {
      const rig = await makeRig("touch");
      const before = (await readdir(rig.stateDir)).sort();
      expect(before).toEqual(["bin", "runs"]);

      await triage(rig, ["--dry-run"]);

      expect((await readdir(rig.stateDir)).sort()).toEqual(before);
      expect(await readdir(rig.runsRoot)).toEqual([]);
      // And named individually, because a directory listing comparison would
      // still pass if all three appeared and `before` had been captured late.
      for (const path of [
        relayRecordPath("triage", rig.env),
        relayLogPath("triage", rig.env),
        relayLockPath("triage", rig.env),
      ]) {
        expect(await Bun.file(path).exists(), `${path} was created by --dry-run`).toBe(false);
      }
    },
    cliBudget(1),
  );
});

describe("no seat in this console has a keyboard — §2.3, §6.1", () => {
  /**
   * §12: *"**Anti: no seat in this console resolves to `pane_mode: tui`.**
   * Probe: resolve all four workers through `resolveWorker` and assert `rpc`; a
   * `tui` seat fails."*
   *
   * Against the TRACKED config, which declares all four seats (`fleet.example.yaml:744`)
   * and says in its own comment why none of them carries an override.
   *
   * **The control is what makes this mean anything.** `obs-1` in the same file
   * IS `pane_mode: tui`, so a `resolveWorker` that answered `rpc` for everything
   * — or a fixture whose config simply had no `tui` worker in it — is RED here.
   * That is the degenerate-fixture failure this branch has recorded four times,
   * in its cheapest form: two sets that are equal in every fixture.
   */
  test("all four resolve to rpc, and the same config still has a tui seat", async () => {
    const cfg = await loadConfig(join(REPO, CONFIG));
    for (const worker of DEFAULT_TRIAGE_WORKERS) {
      expect(resolveWorker(cfg, worker).paneMode, `${worker} has a keyboard`).toBe("rpc");
    }
    // The asymmetry: the resolver CAN say `tui`, and does, for a seat in this
    // same file. Without this line the four assertions above are satisfied by a
    // resolver that lost the field.
    expect(resolveWorker(cfg, "obs-1").paneMode).toBe("tui");
  });

  /**
   * And the script's own half: no pane carries `--attach-here`.
   *
   * The control is a `--workers` override naming four seats the same config
   * declares as `tui`. Without it, an absence proves only that the script never
   * attaches anything — which is exactly what a hard-coded `tuiWorkers = []`
   * would look like, and `scripts/triage`'s own docblock says why it reads the
   * config instead: *"a hard-coded `[]` here would be a decision in `scripts/`
   * about a fact `fleet.yaml` owns."*
   */
  test.skipIf(!EXEC_TMP)(
    "no pane attaches, and the same script attaches four when the config says tui",
    async () => {
      const rig = await makeRig("attach");
      const mine = await triage(rig, ["--dry-run"]);
      expect(mine.out).not.toContain("--attach-here");
      expect(mine.out).not.toContain("--workspace-name");

      const attended = await triage(rig, [
        "--workers",
        "obs-1,tick-1,eng-1,eng-2",
        "--dry-run",
      ]);
      expect((attended.out.match(/'--attach-here'/g) ?? []).length).toBe(4);
      expect(attended.out).toContain(`'--workspace-name' '${TRIAGE_WORKSPACE}'`);
    },
    cliBudget(2),
  );
});

describe("--cadence is refused, and the refusal names the value's home", () => {
  /**
   * §7.8 gives `cadence_s` a home and §13 Phase 6 owns the process that would
   * honour an override. The script ships the flag and refuses it, and the
   * refusal is worth a test because *"the actor this script starts today is
   * `pifleet relay --console triage`"* — passing the value through would hand a
   * usage error to a DETACHED process and leave a record naming a dead pid.
   *
   * Two arms, and the second is the interesting one: a MALFORMED duration must
   * be answered as a duration error rather than as "unimplemented", because the
   * value is parsed before it is refused. A script that refused first would tell
   * an operator who typed `5x` that the feature does not exist yet and never
   * that they mistyped it.
   */
  test.skipIf(!EXEC_TMP)(
    "a valid duration is refused, naming console.yaml and Phase 6",
    async () => {
      const rig = await makeRig("cadence");
      const r = await triage(rig, ["--cadence", "5m"]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("triage/console.yaml");
      expect(r.err).toContain("cadence_s");
      expect(r.err).toContain("--console triage");
      // The parse happened: the refusal quotes the seconds it computed.
      expect(r.err).toContain("300s");
    },
    cliBudget(1),
  );

  test.skipIf(!EXEC_TMP)(
    "a malformed duration is answered as a duration, not as a missing feature",
    async () => {
      const rig = await makeRig("cadence-bad");
      const r = await triage(rig, ["--cadence", "5x"]);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("invalid duration");
      expect(r.err).not.toContain("Phase 6");
    },
    cliBudget(1),
  );
});

describe("the actor's books are this console's, never the review console's", () => {
  /**
   * §12: *"**Anti: the triage actor's record, log and lock are not the review
   * console's.** Probe: assert the three paths differ from
   * `relayRecordPath`/`relayLogPath`/`relayLockPath`'s review values, and that
   * `servesConsole` refuses a record naming the other console.
   * **`console-relay.ts:79-86` and `:525-527` hard-code `review-`, so a
   * copy-paste actor takes over the review console's lock and the symptom is a
   * review console that silently stops fanning out.**"*
   */
  test("the three paths differ from the review console's, and the basenames say which", () => {
    const env = { ...process.env, PIFLEET_RUNS_DIR: "/tmp/pf-paths-only/runs" };
    for (const [triagePath, reviewPath] of [
      [relayRecordPath("triage", env), relayRecordPath("review", env)],
      [relayLogPath("triage", env), relayLogPath("review", env)],
      [relayLockPath("triage", env), relayLockPath("review", env)],
    ]) {
      expect(triagePath).not.toBe(reviewPath);
      expect(triagePath).toContain("triage-relay.");
      expect(triagePath).not.toContain("review-relay.");
    }
  });

  test("servesConsole refuses a record naming the other console", () => {
    const base: RelayRecord = {
      schema: "pifleet.consolerelay/v1",
      pid: 1,
      started: "utc1 x",
      console: "review",
      run_id: "R1",
      pinned: null,
      workers: [...DEFAULT_TRIAGE_WORKERS],
      started_at: new Date().toISOString(),
      log_path: "/dev/null",
    };
    const asked = { name: "triage" as const, runId: "R1", workers: DEFAULT_TRIAGE_WORKERS };
    // Identical in run id and workers; only the console differs, which is the
    // whole point — `run_id` and `workers` cannot tell two consoles apart.
    expect(servesConsole(base, asked)).toBe(false);
    expect(servesConsole({ ...base, console: "triage" }, asked)).toBe(true);
    // And a record written before the actor named its console matches nobody.
    expect(servesConsole({ ...base, console: "" }, asked)).toBe(false);
  });

  /**
   * THE EXECUTED VERSION, and it is the one that would have caught the defect.
   *
   * Two records sit side by side in one state directory — this console's and the
   * review console's — both naming a live process. `--actor-stop` must signal
   * exactly one of them. A script that had inherited `scripts/review`'s
   * hard-coded basename passes both path assertions above (they test the
   * library) and kills the wrong process here.
   *
   * `--actor-stop` is answered BEFORE the cmux probe, so this arm needs no stub
   * at all — but it is the arm with the sharpest consequence, so the rig's
   * `PIFLEET_RUNS_DIR` guard is what stands between it and the operator's own
   * running actor.
   */
  test.skipIf(!EXEC_TMP)(
    "--actor-stop stops THIS console's actor and leaves the review console's alone",
    async () => {
      const rig = await makeRig("stop");
      const mine = await plantActor(rig, "triage", "R-triage");
      const theirs = await plantActor(rig, "review", "R-review");
      expect(mine.pid).not.toBe(theirs.pid);

      const r = await triage(rig, ["--actor-stop"]);
      expect(r.code).toBe(0);
      expect(r.err).toContain(`pid ${mine.pid}`);
      expect(r.err).toContain("signalled");
      expect(r.err).not.toContain(`pid ${theirs.pid}`);

      // The signalled process is gone and its record with it.
      expect((await readRelayStatus(mine.path)).kind).toBe("absent");
      // The review console's actor is untouched, and it is asserted on the
      // PROCESS as well as on the file: a stop that removed the record without
      // signalling, or signalled without removing, is a different bug each way.
      const survivor = await readRelayStatus(theirs.path);
      expect(survivor.kind).toBe("live");
      if (survivor.kind === "live") expect(survivor.record.pid).toBe(theirs.pid);
    },
    cliBudget(1),
  );
});

describe("--restart refuses before it destroys — ISC-572, on the fourth console", () => {
  /**
   * §12: *"**Anti: `scripts/triage --restart <id> --task <f>` stops the actor
   * AFTER the settle wait.** Probe: ISC-572's own probe, re-taken on this
   * console: with a worker holding a task, assert the refusal AND that the triage
   * actor record still names a live pid. **The same defect a fourth time is the
   * one most likely to ship.**"*
   *
   * THE FAST ARM. An unplannable worker throws out of `plan()`, which
   * `scripts/triage` calls on the line above `recreateThenDispatch`. That is the
   * `--task` path's first irreversible-step guard and it is reachable in
   * milliseconds, so the whole invariant — a refusal, a non-zero exit, and an
   * actor still live — is executed end to end rather than reasoned about.
   *
   * `sre-1` is a real worker in the tracked config that this console does not
   * plan, which is precisely the shape `resolveThenRestart`'s docblock records
   * measuring on `scripts/operations`: *"Both operations workers were left DOWN
   * with nothing respawned."*
   */
  test.skipIf(!EXEC_TMP)(
    "a worker this console does not plan is refused with the actor still live",
    async () => {
      const rig = await makeRig("plan-refusal");
      const actor = await plantActor(rig, "triage", "R-1");

      const r = await triage(rig, ["--restart", "sre-1", "--task", "/dev/null"]);

      expect(r.code).not.toBe(0);
      expect(r.err).toContain("is not a pane this console plans");
      // It names the four it DOES plan, so an operator is told what to type.
      for (const worker of DEFAULT_TRIAGE_WORKERS) expect(r.err).toContain(worker);
      // Nothing was stopped, and that is asserted on the record AND on stderr:
      // a stop that happened would have printed its own line.
      expect(r.err).not.toContain("stopping the actor");
      expect(r.err).not.toContain("stopping run");

      const after = await readRelayStatus(actor.path);
      expect(after.kind).toBe("live");
      if (after.kind === "live") expect(after.record.pid).toBe(actor.pid);
    },
    cliBudget(1),
  );

  /**
   * THE ISC-572 SHAPE ITSELF — a worker genuinely holding a task.
   *
   * `recreateThenDispatch` polls `status --all --json` every 3s for up to twenty
   * minutes before it refuses, and `scripts/triage` passes no override, so the
   * refusal's own sentence is out of reach of any test budget. **What ISC-572 is
   * about is reachable in seconds**: the defect it records is a console that took
   * its fifth process down ABOVE the wait, making the eventual refusal's words
   * *"Nothing has been stopped"* false. So this drives the real script against a
   * real busy worker, watches the actor record across several poll cycles, and
   * asserts it is still live — which is the state a defective ordering destroys
   * on the FIRST pass, before the first poll.
   *
   * The script is then terminated. That is stated in this file's header as a
   * limitation rather than left for a reader to infer from a `kill`.
   *
   * `plantBusyRun` is what makes it a real wait: without a busy worker the
   * script would settle immediately and go on to stop runs and respawn a pane,
   * which the cmux stub refuses — a different test with a different meaning.
   */
  test.skipIf(!EXEC_TMP)(
    "with tri-1 holding a task, the actor is still live several polls into the wait",
    async () => {
      const rig = await makeRig("busy");
      const runId = "2026-09-06T00-00-00Z-busy";
      await plantBusyRun(rig, runId, "tri-1");
      const actor = await plantActor(rig, "triage", runId);

      const proc = Bun.spawn(
        [
          "bun",
          "run",
          "scripts/triage",
          "--config",
          CONFIG,
          "--restart",
          "tri-1",
          "--task",
          "/dev/null",
        ],
        { cwd: REPO, env: rig.env, stdout: "pipe", stderr: "pipe" },
      );
      try {
        // `recreateThenDispatch`'s poll is 3s. Three of them, so the assertion
        // is about a wait that is genuinely running rather than about a process
        // that has not started yet.
        await Bun.sleep(9_500);

        // It is STILL WAITING — not exited, not crashed. A script that had
        // refused or proceeded would be gone, and "the record survived" would
        // then be a statement about a process that never looked at it.
        expect(proc.exitCode, "the script left the settle wait early").toBeNull();

        const after = await readRelayStatus(actor.path);
        expect(after.kind, "the actor was stopped ABOVE the wait — ISC-572, a fourth time").toBe(
          "live",
        );
        if (after.kind === "live") expect(after.record.pid).toBe(actor.pid);
      } finally {
        proc.kill("SIGKILL");
        await proc.exited;
      }

      // And nothing was torn down while it waited. Read AFTER the kill so the
      // whole stream is drained rather than a prefix of it.
      const err = await new Response(proc.stderr).text();
      expect(err).not.toContain("stopping the actor");
      expect(err).not.toContain("stopping run");
      expect(err).not.toContain("respawning");
    },
    cliBudget(4),
  );
});
