/**
 * The container launch path: the supervisor runs the LAUNCH RECORD's argv, and
 * runs it verbatim.
 *
 * ## Why "verbatim" is the thing under test
 *
 * There are two launch paths and they need opposite treatment at the same
 * seam. `buildPiArgv` already ends a rendered container argv with
 * `--mode rpc --session-id <id> --session-dir /sessions` — CONTAINER paths,
 * because the run dir is bind-mounted at `/sessions` inside. The
 * `PIFLEET_PI_COMMAND` double gets those three flags appended by the
 * supervisor, spelled with HOST paths.
 *
 * Appending the host spelling to a container argv would not throw. `pi` takes
 * the LAST `--session-dir`, so the container would write sessions to a host
 * path that does not exist inside it, the supervisor would keep answering,
 * tasks would keep settling, and `harvest` would find nothing. A fleet that
 * looks alive and produces no transcripts is the failure this file exists to
 * make impossible, and no assertion about "the container started" would catch
 * it — which is why these tests assert on the ARGV rather than on liveness.
 *
 * ## Why the "container" here is a shell script
 *
 * The argv the supervisor spawns is opaque to it: `Bun.spawn` of a `docker
 * run …` line and `Bun.spawn` of a script are the same operation, and what is
 * being tested is which argv it chose and whether it altered it. Planting a
 * recorder as the argv observes exactly that, on any machine, with no daemon
 * and no image. `test/e2e` owns whether a real image runs.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, writeFile, chmod, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPaths, workerPaths } from "../../src/run/paths.ts";
import { WorkerLaunchSchema } from "../../src/contracts.ts";
import { writeJsonAtomic } from "../../src/util/jsonl.ts";
import { processLauncher, supervisorArgv } from "../../src/supervisor/launch.ts";
import { cliBudget } from "../support/budget.ts";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups) await c().catch(() => {});
});

/**
 * A stand-in for `docker run` that records the argv it was invoked with.
 *
 * Sleeps rather than exiting so the supervisor treats it as a live child; the
 * test reads the recording, not the exit.
 */
async function plantRecorder(dir: string): Promise<{ bin: string; recording: string }> {
  const bin = join(dir, "recorder.sh");
  const recording = join(dir, "argv.txt");
  await writeFile(
    bin,
    `#!/bin/sh\n: > ${recording}\nfor a in "$@"; do printf '%s\\n' "$a" >> ${recording}; done\nsleep 30\n`,
  );
  await chmod(bin, 0o755);
  return { bin, recording };
}

async function plantRun(): Promise<{ root: string; runId: string }> {
  const root = await mkdtemp(join(tmpdir(), "cl-"));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const runId = "r-cl";
  const run = runPaths(runId, root);
  await mkdir(workerPaths(run, "eng-1").dir, { recursive: true });
  await mkdir(run.sessionsDir, { recursive: true });
  return { root, runId };
}

function launch(root: string, runId: string, env: Record<string, string>) {
  const run = runPaths(runId, root);
  return processLauncher.launchDetached({
    runId,
    runDir: run.root,
    workerId: "eng-1",
    argv: supervisorArgv({ runsRoot: root, runId, workerId: "eng-1" }),
    env,
    logPath: workerPaths(run, "eng-1").supervisorLog,
  }).then((res) => {
    cleanups.push(async () => {
      try {
        process.kill(-res.pgid, "SIGKILL");
      } catch {
        try {
          process.kill(res.pid, "SIGKILL");
        } catch {
          // Already gone.
        }
      }
    });
    return res;
  });
}

async function waitForFile(path: string, budgetMs: number): Promise<string | null> {
  const start = performance.now();
  for (;;) {
    const text = await readFile(path, "utf8").catch(() => null);
    if (text !== null && text.length > 0) return text;
    if (performance.now() - start > budgetMs) return null;
    await new Promise((r) => setTimeout(r, 50));
  }
}

describe("the supervisor launches from the launch record", () => {
  /**
   * The criterion, and the whole point of the record: what runs is what was
   * rendered, with nothing added.
   *
   * Fails if: the supervisor appends its host-path rpc flags to a container
   * argv (the silent-wrong mode), or reorders, or drops an element.
   */
  test(
    "a recorded argv is spawned VERBATIM — no flags appended",
    async () => {
      const { root, runId } = await plantRun();
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      const { bin, recording } = await plantRecorder(wp.dir);

      // A deliberately container-SHAPED argv: it already ends with the three
      // flags the double path appends, spelled the way a container needs.
      const argv = [
        bin,
        "--mode",
        "rpc",
        "--session-id",
        "eng-1",
        "--session-dir",
        "/sessions",
        "--sentinel",
        "keep-me-last",
      ];
      await writeJsonAtomic(
        wp.launchJson,
        WorkerLaunchSchema.parse({
          kind: "container",
          argv,
          container: "pifleet-r-cl-eng-1",
          image: "pifleet/pi-worker:test",
        }),
      );

      await launch(root, runId, { PIFLEET_RUNS_DIR: root });
      const recorded = await waitForFile(recording, 10_000);
      expect(recorded, "the recorder was never spawned").not.toBeNull();

      // argv[0] is the program itself and is not in "$@".
      expect(recorded!.trimEnd().split("\n")).toEqual(argv.slice(1));
    },
    cliBudget(1),
  );

  /**
   * The SUPERVISOR's rule, stated for the case where both inputs are present.
   *
   * In a run built by `up` they never are: `up` makes the choice once and
   * writes no launch record when `PIFLEET_PI_COMMAND` is set, precisely so
   * the run directory cannot describe two different intentions. This pins the
   * supervisor's own rule anyway — a record means launch it — because that
   * rule is what makes `up`'s decision effective, and a hand-assembled run
   * directory (which is how much of this suite works) can still present both.
   */
  test(
    "a launch record wins over a PIFLEET_PI_COMMAND that is also set",
    async () => {
      const { root, runId } = await plantRun();
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      const { bin, recording } = await plantRecorder(wp.dir);
      const decoy = join(wp.dir, "decoy.txt");

      await writeJsonAtomic(
        wp.launchJson,
        WorkerLaunchSchema.parse({
          kind: "container",
          argv: [bin, "--from-record"],
          container: "pifleet-r-cl-eng-1",
          image: "pifleet/pi-worker:test",
        }),
      );

      await launch(root, runId, {
        PIFLEET_RUNS_DIR: root,
        PIFLEET_PI_COMMAND: `/bin/sh -c ": > ${decoy}"`,
      });

      const recorded = await waitForFile(recording, 10_000);
      expect(recorded, "the recorded argv was not the one spawned").not.toBeNull();
      expect(recorded!.trimEnd().split("\n")).toEqual(["--from-record"]);
      // And the double was never touched.
      expect(await readFile(decoy, "utf8").catch(() => null)).toBeNull();
    },
    cliBudget(1),
  );

  /**
   * The container NAME reaches `state.json` before anything else happens.
   *
   * `down` removes the container by that name, and `docker run --rm` cannot
   * help it: `--rm` is a client-side action that fires when the container
   * EXITS, and every rung of the kill ladder except a graceful shutdown kills
   * the client. A supervisor that recorded the name only after a successful
   * start would leave exactly the orphan `down` is meant to reap.
   */
  test(
    "state.container carries the name and image from the record",
    async () => {
      const { root, runId } = await plantRun();
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      const { bin } = await plantRecorder(wp.dir);

      await writeJsonAtomic(
        wp.launchJson,
        WorkerLaunchSchema.parse({
          kind: "container",
          argv: [bin],
          container: "pifleet-r-cl-eng-1",
          image: "pifleet/pi-worker:test",
        }),
      );
      await launch(root, runId, { PIFLEET_RUNS_DIR: root });

      const text = await waitForFile(wp.stateJson, 10_000);
      expect(text, "no state.json was written").not.toBeNull();
      const state = JSON.parse(text!) as { container: { name: string; image: string } | null };
      expect(state.container).not.toBeNull();
      expect(state.container!.name).toBe("pifleet-r-cl-eng-1");
      expect(state.container!.image).toBe("pifleet/pi-worker:test");
    },
    cliBudget(1),
  );

  /**
   * The double path is untouched by all of the above.
   *
   * Every e2e and integration test in this repo runs this way, so this is the
   * regression that would hurt most. `state.container` stays null: a
   * host-process run has no container, and reporting one would make `down`
   * issue a `docker rm` for a name that never existed.
   */
  test(
    "with no launch record the double still runs, and container stays null",
    async () => {
      const { root, runId } = await plantRun();
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      const { bin, recording } = await plantRecorder(wp.dir);

      await launch(root, runId, { PIFLEET_RUNS_DIR: root, PIFLEET_PI_COMMAND: bin });

      const recorded = await waitForFile(recording, 10_000);
      expect(recorded, "the double was never spawned").not.toBeNull();
      // The double path DOES append, with host paths — the other half of the
      // asymmetry this file is about.
      const args = recorded!.trimEnd().split("\n");
      expect(args).toContain("--mode");
      expect(args).toContain(run.sessionsDir);

      const text = await waitForFile(wp.stateJson, 10_000);
      const state = JSON.parse(text!) as { container: unknown };
      expect(state.container).toBeNull();
    },
    cliBudget(1),
  );
});

/**
 * `down` removes the container the launch record names.
 *
 * Gated on `PIFLEET_DOCKER=1` like the other daemon-dependent suites, because
 * the only honest probe for "the container is gone" is a real container. A
 * fake here would assert that a function was called, which is the thing that
 * was never in doubt — what is in doubt is whether `docker rm -f` reaches a
 * container started by a DIFFERENT process and already detached from its
 * client, which is exactly the orphan case.
 */
const DOCKER = process.env["PIFLEET_DOCKER"] === "1";
if (!DOCKER) {
  console.warn(
    "[skip] container teardown test needs a Docker daemon. Run with PIFLEET_DOCKER=1.",
  );
}

describe.skipIf(!DOCKER)("down reaps the container", () => {
  /**
   * The orphan case, staged exactly.
   *
   * The container is started DETACHED and its client exits immediately —
   * which is what a SIGKILLed supervisor leaves behind, and the state `--rm`
   * cannot clean up, since `--rm` fires when the container exits and nothing
   * is going to exit a `sleep 300`.
   *
   * Fails if: `down` skips removal, or removes by a name it derived
   * differently from the one recorded.
   */
  test(
    "a detached container whose client is gone is removed by name",
    async () => {
      const { root, runId } = await plantRun();
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      const name = `pifleet-${runId}-eng-1`;

      const start = Bun.spawn(
        ["docker", "run", "-d", "--rm", "--name", name, "alpine:latest", "sleep", "300"],
        { stdout: "ignore", stderr: "pipe" },
      );
      const startErr = await new Response(start.stderr).text();
      expect(await start.exited, `docker run failed: ${startErr}`).toBe(0);
      cleanups.push(async () => {
        Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
      });

      const alive = async (): Promise<boolean> => {
        const p = Bun.spawn(
          ["docker", "ps", "-a", "--filter", `name=^${name}$`, "--format", "{{.Names}}"],
          { stdout: "pipe", stderr: "ignore" },
        );
        const out = (await new Response(p.stdout).text()).trim();
        await p.exited;
        return out === name;
      };
      expect(await alive(), "the fixture container did not start").toBe(true);

      /*
       * A worker whose supervisor is already gone: pid 1 is never this
       * supervisor, so the identity anchor refuses to signal and `down`
       * proceeds to teardown without killing anything. That isolates the
       * container rung, which is what this test is about.
       */
      await writeJsonAtomic(wp.stateJson, {
        schema: "pifleet.state/v1",
        worker: "eng-1",
        run_id: runId,
        pid: 999_999,
        pgid: 999_999,
        started_at: new Date().toISOString(),
        proc_started: "",
        container: { name, id: "", image: "alpine:latest" },
        phase: "idle",
        epoch: 0,
      });

      const cli = join(new URL("../../", import.meta.url).pathname, "src/cli/index.ts");
      const down = Bun.spawn(
        [process.execPath, cli, "down", "--run", runId, "--json"],
        { env: { ...process.env, PIFLEET_RUNS_DIR: root }, stdout: "pipe", stderr: "pipe" },
      );
      await down.exited;

      expect(await alive(), "down left the container running").toBe(false);
    },
    cliBudget(2),
  );
});
