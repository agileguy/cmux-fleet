/**
 * The Phase 4 headline (ISC-134 / ISC-128): the tmux backend produces the SAME
 * acceptance results as headless. Presentation must not change outcomes — that
 * is the entire point of the FleetBackend seam, and this file is where it is
 * proven end-to-end rather than argued from the interface.
 *
 * Method: drive a REAL `up → dispatch → wait → artifacts → down` run against
 * the fake-pi double on `headless`, then the SAME run on `tmux`, and compare
 * the artifacts — verdicts, settle reasons, epochs, task records — as one
 * deep-equal on a collected outcome object. Two guards keep the comparison
 * honest:
 *
 *  1. Every tmux fleet is verified to have actually LANDED on tmux (the
 *     session exists on the fleet's private server). Equivalence between a
 *     headless run and a silently-headless "tmux" run would prove nothing.
 *  2. The invariant fields are ALSO asserted absolutely (verdict "success",
 *     exit 0, epoch 1, …), never only compared. A mutation that degrades both
 *     backends identically — the settle path writing every verdict as
 *     "success", say — keeps the cross-backend comparison green and is caught
 *     only by the absolute half.
 *
 * NORMALIZATION — exactly these fields are excluded from comparison, because
 * each is legitimately different per run, and none carries an outcome:
 *  - `run_id` / `settled_at`: fresh id and wall clock per run.
 *  - `attempt_id`: random per dispatch.
 *  - `session_path`: contains the run id and tmpdir; its PRESENCE is compared
 *    (session_present), the path string is not.
 *  - pids / pgids: process identity.
 *  - workspace/pane refs: backend-native by declaration (WorkspaceRef.id is
 *    null on headless, a session name on tmux) — the one difference the seam
 *    permits, and nothing correctness-bearing may read them.
 * Everything else — verdicts, reasons, epochs, acceptance flags, completed
 * epoch lists, transcript presence — is compared verbatim.
 *
 * tmux isolation: each fleet gets a private TMUX_TMPDIR under os.tmpdir() (the
 * default-socket path must stay under macOS's ~104-byte sun_path cap), so
 * concurrent runs and the developer's own tmux are structurally untouchable.
 * The direct-backend control in the ISC-135 test uses a per-file `-L` socket
 * for the same reason. All servers die in afterAll even when a test fails.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { EXIT } from "../../src/contracts.ts";
import { runPaths, taskRecordPath, workerPaths } from "../../src/run/paths.ts";
import { readTaskRecord } from "../../src/run/state.ts";
import { realExec } from "../../src/container/run.ts";
import { TmuxBackend } from "../../src/backends/tmux/index.ts";
import { tmuxArgv } from "../../src/backends/tmux/argv.ts";
import type { Exec } from "../../src/container/run.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const CLI = join(ROOT_URL, "src/cli/index.ts");
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIOS = join(ROOT_URL, "test/fixtures/scenarios");

const WORKERS = ["eng-1", "eng-2"] as const;

/** Private `-L` socket for the direct-backend ISC-135 control, per test run. */
const CONTROL_SOCKET = `pifleet-eq-ctl-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const CONTROL_CTX = { socketName: CONTROL_SOCKET, configFile: "/dev/null" };

interface Fleet {
  base: string;
  root: string;
  tmuxTmp: string;
  runId: string;
  backend: "headless" | "tmux";
  env: Record<string, string>;
}

const fleets: Fleet[] = [];
afterAll(async () => {
  for (const f of fleets) {
    if (f.runId !== "") await cli(f, ["down", "--run", f.runId, "--json"]).catch(() => {});
    await Bun.spawn(["tmux", "kill-server"], {
      env: { ...process.env, TMUX_TMPDIR: f.tmuxTmp },
      stdout: "ignore",
      stderr: "ignore",
    }).exited.catch(() => {});
    await rm(f.base, { recursive: true, force: true }).catch(() => {});
  }
  await realExec(tmuxArgv(CONTROL_CTX, ["kill-server"])).catch(() => {});
});

async function cli(
  fleet: Fleet,
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  const p = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...fleet.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
  ]);
  return { code: await p.exited, stdout, stderr };
}

function json<T>(r: { stdout: string }): T {
  return JSON.parse(r.stdout.trim()) as T;
}

async function makeFleet(
  backend: "headless" | "tmux",
  scenario: string,
  pathPrefix?: string,
): Promise<Fleet> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-eq-"));
  const root = join(base, "runs");
  const tmuxTmp = join(base, "tmux");
  await mkdir(root, { recursive: true });
  await mkdir(tmuxTmp, { recursive: true });
  const fleet: Fleet = {
    base,
    root,
    tmuxTmp,
    runId: "",
    backend,
    env: {
      PIFLEET_RUNS_DIR: root,
      PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${join(SCENARIOS, scenario)}`,
      TMUX_TMPDIR: tmuxTmp,
      ...(pathPrefix !== undefined
        ? { PATH: `${pathPrefix}:${process.env["PATH"] ?? ""}` }
        : {}),
    },
  };
  fleets.push(fleet);
  return fleet;
}

async function waitUntil(cond: () => Promise<boolean>, budgetMs: number): Promise<boolean> {
  const start = performance.now();
  for (;;) {
    if (await cond()) return true;
    if (performance.now() - start > budgetMs) return false;
    await new Promise((r) => setTimeout(r, 50));
  }
}

interface StatusJson {
  workers: Array<{
    id: string;
    phase: string | null;
    session_present: boolean;
    completed_epochs: number[];
  }>;
}

interface WaitJson {
  exit: number;
  tasks: Array<{ task_id: string; verdict: string; reason: string; epoch: number | null }>;
}

/**
 * Everything a run PRODUCES, with the normalized fields (header comment)
 * already excluded. Two outcomes from two backends must deep-equal; anything
 * that diverges is presentation leaking into results.
 */
interface Outcome {
  upExit: number;
  tasks: Array<{
    taskId: string;
    dispatch: { accepted: boolean; epoch: number };
    wait: { exit: number; verdict: string; reason: string; epoch: number | null };
    /** The on-disk task record minus run_id / attempt_id / settled_at. */
    record: {
      schema: string;
      task_id: string;
      worker: string;
      epoch: number;
      verdict: string;
      reason: string;
    } | null;
  }>;
  /** Per worker after settle: everyone idle again, transcript present, epochs. */
  workers: Array<{ id: string; idleAgain: boolean; sessionPresent: boolean; completedEpochs: number[] }>;
  downExit: number;
  downClean: boolean;
}

/**
 * The identical driver conversation on any backend: up two workers, dispatch
 * one task to each, wait both, harvest the artifacts from disk, down.
 */
async function runAcceptance(fleet: Fleet, waitTimeout = "15s"): Promise<Outcome> {
  const up = await cli(fleet, [
    "up",
    "--workers",
    WORKERS.join(","),
    "--backend",
    fleet.backend,
    "--json",
  ]);
  expect(up.code).toBe(EXIT.SUCCESS);
  fleet.runId = json<{ run_id: string }>(up).run_id;

  if (fleet.backend === "tmux") {
    // Guard 1: the run must actually be ON tmux. If ensureWorkspace silently
    // no-opped, this file would be comparing headless with headless and
    // certifying nothing.
    const has = Bun.spawn(["tmux", "has-session", "-t", `=pifleet-${fleet.runId}`], {
      env: { ...process.env, TMUX_TMPDIR: fleet.tmuxTmp },
      stdout: "ignore",
      stderr: "ignore",
    });
    expect(await has.exited).toBe(0);
  }

  const run = runPaths(fleet.runId, fleet.root);
  const outcome: Outcome = {
    upExit: up.code,
    tasks: [],
    workers: [],
    downExit: -1,
    downClean: false,
  };

  for (let i = 0; i < WORKERS.length; i++) {
    const workerId = WORKERS[i]!;
    const taskId = `T-EQ${i + 1}`;
    // Task files live BESIDE the runs root, never inside it (the root listing
    // is how latestRunId resolves).
    const taskFile = join(fleet.base, `${taskId}.task.json`);
    await writeFile(
      taskFile,
      JSON.stringify({
        task_id: taskId,
        title: `equivalence ${taskId}`,
        brief: `Perform the scripted work for ${taskId}.`,
        deadline_s: 300,
      }),
    );
    const d = await cli(fleet, ["dispatch", "--worker", workerId, "--task", taskFile, "--json"]);
    expect(d.code).toBe(EXIT.SUCCESS);
    const dj = json<{ accepted: boolean; epoch: number }>(d);

    const w = await cli(fleet, ["wait", "--task", taskId, "--timeout", waitTimeout, "--json"]);
    const wj = json<WaitJson>(w);
    const wt = wj.tasks[0]!;

    const rec = await readTaskRecord(taskRecordPath(workerPaths(run, workerId), taskId));
    outcome.tasks.push({
      taskId,
      dispatch: { accepted: dj.accepted, epoch: dj.epoch },
      wait: { exit: w.code, verdict: wt.verdict, reason: wt.reason, epoch: wt.epoch },
      record:
        rec === null
          ? null
          : {
              schema: rec.schema,
              task_id: rec.task_id,
              worker: rec.worker,
              epoch: rec.epoch,
              verdict: rec.verdict,
              reason: rec.reason,
            },
    });
  }

  // Settle is asynchronous with the worker's return to idle and the session
  // file's appearance, so both are polled with a budget rather than sampled
  // once — the OUTCOME recorded is "did it happen", identically racy on both
  // backends, not "had it happened yet at an arbitrary instant".
  for (const workerId of WORKERS) {
    const idleAgain = await waitUntil(async () => {
      const s = json<StatusJson>(await cli(fleet, ["status", "--run", fleet.runId, "--json"]));
      return s.workers.find((w) => w.id === workerId)?.phase === "idle";
    }, 10_000);
    const sessionPresent = await waitUntil(async () => {
      const s = json<StatusJson>(await cli(fleet, ["status", "--run", fleet.runId, "--json"]));
      return s.workers.find((w) => w.id === workerId)?.session_present === true;
    }, 5_000);
    const st = json<StatusJson>(await cli(fleet, ["status", "--run", fleet.runId, "--json"]));
    outcome.workers.push({
      id: workerId,
      idleAgain,
      sessionPresent,
      completedEpochs: st.workers.find((w) => w.id === workerId)?.completed_epochs ?? [],
    });
  }

  const down = await cli(fleet, ["down", "--run", fleet.runId, "--json"]);
  outcome.downExit = down.code;
  outcome.downClean = json<{ clean: boolean }>(down).clean;
  return outcome;
}

/** Outcomes stashed by the headline tests; the ISC-135 test compares against them. */
const stash = new Map<string, Outcome>();

describe("ISC-134/128: tmux and headless produce the same acceptance results", () => {
  test(
    "the same successful run settles identical artifacts on both backends",
    async () => {
      const headless = await runAcceptance(await makeFleet("headless", "happy.json"));
      const tmux = await runAcceptance(await makeFleet("tmux", "happy.json"));

      // Guard 2 (absolute half): the artifacts say what they MUST say, on the
      // headless run first. Comparison alone would bless two identically
      // wrong runs.
      expect(headless.upExit).toBe(EXIT.SUCCESS);
      for (const t of headless.tasks) {
        expect(t.dispatch).toEqual({ accepted: true, epoch: 1 });
        expect(t.wait.exit).toBe(EXIT.SUCCESS);
        expect(t.wait.verdict).toBe("success");
        expect(t.record?.verdict).toBe("success");
        expect(t.record?.epoch).toBe(1);
      }
      for (const w of headless.workers) {
        expect(w.idleAgain).toBe(true);
        expect(w.sessionPresent).toBe(true);
        expect(w.completedEpochs).toEqual([1]);
      }
      expect(headless.downClean).toBe(true);

      // The headline: byte-identical outcomes. Any field diverging here is a
      // backend changing a RESULT, which the seam exists to make impossible.
      expect(tmux).toEqual(headless);

      stash.set("happy-headless", headless);
      stash.set("happy-tmux", tmux);
    },
    120_000,
  );

  test(
    "a FAILING run settles identically on both backends — equivalence must hold for bad news too",
    async () => {
      // late-failure: the prompt acks accepted, then a late success:false
      // fails the epoch (ISC-86). If a backend changed anything about the
      // failure path — verdict, reason, exit — an operator would get
      // different bad news depending on what they happened to be watching.
      const headless = await runAcceptance(await makeFleet("headless", "late-failure.json"));
      const tmux = await runAcceptance(await makeFleet("tmux", "late-failure.json"));

      for (const t of headless.tasks) {
        expect(t.dispatch.accepted).toBe(true);
        expect(t.wait.exit).toBe(EXIT.PARTIAL);
        expect(t.wait.verdict).toBe("failed");
        expect(t.wait.reason).toContain("late_prompt_failure");
        expect(t.record?.verdict).toBe("failed");
      }
      expect(tmux).toEqual(headless);
    },
    120_000,
  );
});

describe("ISC-135 (anti): readScreen is diagnostics only — losing it changes NO acceptance result", () => {
  /**
   * A `tmux` wrapper that fails every `capture-pane` (the verb readScreen is
   * built on) and passes everything else through to the real binary. Under
   * this PATH, every load-bearing tmux verb works and the diagnostics verb
   * does not — the exact shape of the live cmux probe that motivated ISC-135,
   * where read-screen returned internal_error on a healthy surface.
   */
  async function writeCapturePaneBreakingShim(bin: string): Promise<string> {
    const realTmux = Bun.which("tmux");
    expect(realTmux).toBeTruthy();
    const shim = join(bin, "tmux");
    await writeFile(
      shim,
      [
        "#!/bin/sh",
        'for a in "$@"; do',
        '  if [ "$a" = "capture-pane" ]; then',
        '    echo "tmux shim: capture-pane disabled on purpose" >&2',
        "    exit 1",
        "  fi",
        "done",
        `exec ${realTmux} "$@"`,
        "",
      ].join("\n"),
    );
    await chmod(shim, 0o755);
    return shim;
  }

  test(
    "with capture-pane disabled, the tmux run's artifacts are identical to the healthy tmux run's",
    async () => {
      const bin = await mkdtemp(join(tmpdir(), "pifleet-noread-"));
      const shim = await writeCapturePaneBreakingShim(bin);

      // POSITIVE CONTROL, or the test is vacuous: prove the shim actually
      // disables readScreen through the production seam while the
      // load-bearing verbs keep working. `shimExec` routes the backend's own
      // argv through the shim, exactly as PATH resolution will for the CLI.
      const shimExec: Exec = (argv, opts) =>
        realExec([argv[0] === "tmux" ? shim : argv[0]!, ...argv.slice(1)], opts);
      const broken = new TmuxBackend({ exec: shimExec, ...CONTROL_CTX });
      const ws = await broken.ensureWorkspace("eq-noread");
      const pane = await broken.createPane(ws, { workerId: "eng-1", cwd: "/tmp" });
      await broken.attachViewer(pane, ["/bin/sh", "-c", "printf 'ALIVE '; exec sleep 3600"]);
      await expect(broken.readScreen(pane)).rejects.toThrow(/capture-pane/);
      // Same server, unshimmed: readScreen works — the failure above came
      // from the shim, not from a broken server invalidating the control.
      const healthy = new TmuxBackend({ exec: realExec, ...CONTROL_CTX });
      expect(await healthy.readScreen(pane)).toContain("ALIVE");
      await broken.destroy(ws, { keepPanes: false });

      // The run itself, with readScreen unavailable fleet-wide via PATH.
      const outcome = await runAcceptance(await makeFleet("tmux", "happy.json", bin));

      // Identical to the healthy tmux run from the headline test — verdicts,
      // reasons, epochs, records, all of it. If any correctness path consults
      // readScreen (today or after a future edit to up/attach/doctor), this
      // run diverges or dies, and this assertion is the tripwire. ISC-134's
      // guard inside runAcceptance already proved this run landed on tmux.
      const reference = stash.get("happy-tmux");
      expect(reference).toBeDefined();
      expect(outcome).toEqual(reference!);

      await rm(bin, { recursive: true, force: true });
    },
    120_000,
  );
});
