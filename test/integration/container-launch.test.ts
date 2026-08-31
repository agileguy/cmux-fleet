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
import { cliBudget, gateBudget } from "../support/budget.ts";
import { hostAdcFile, TOKEN_FILE } from "../../src/security/adc.ts";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => {
  for (const c of cleanups) await c().catch(() => {});
});

/**
 * A stand-in for `docker run` that records the argv it was invoked with.
 *
 * Sleeps rather than exiting so the supervisor treats it as a live child; the
 * test reads the recording, not the exit.
 *
 * THE RENAME IS LOAD-BEARING, and it is here because the earlier version was
 * flaky in one direction only. `waitForFile` returns on the first non-empty
 * read, while the recorder appends ONE LINE PER ARGUMENT — so a reader that
 * arrived mid-loop saw a PREFIX of the argv and the test failed comparing a
 * correctly-spawned command against a partially-written file. It surfaced
 * first under `--coverage`, which is simply slow enough to widen the window.
 *
 * Building in `.part` and renaming makes the visible file atomic: any read
 * that finds `argv.txt` at all finds all of it. **Reproduced deliberately
 * rather than inferred:** injecting `sleep 0.2` between the appends turns two
 * of this file's three recorder tests red against the append-in-place version
 * and leaves all four green against this one.
 */
async function plantRecorder(dir: string): Promise<{ bin: string; recording: string }> {
  const bin = join(dir, "recorder.sh");
  const recording = join(dir, "argv.txt");
  await writeFile(
    bin,
    `#!/bin/sh\n: > ${recording}.part\n` +
      `for a in "$@"; do printf '%s\\n' "$a" >> ${recording}.part; done\n` +
      `mv ${recording}.part ${recording}\nsleep 30\n`,
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
    /**
     * `gateBudget` and NOT `cliBudget(1)`, for every test in this file
     * (ISC-273/274).
     *
     * `cliBudget(1)` is 5700 ms and these tests' `waitForFile` gates are
     * 10 000 ms each — so the ceiling sat BELOW the gate it was meant to
     * cover, and bun killed the test at 5700 ms with the declared wait
     * unspendable. One test below has TWO such gates under that single
     * ceiling. On a light runner the spawn lands in ~2 s and they pass; under
     * load they do not, and the failure reads as "the recorder was never
     * spawned" rather than as a budget that was never large enough.
     *
     * Found when ISC-147's twenty-two supervisor launches made the suite heavy
     * enough to expose it — a latent defect surfaced by unrelated load, which
     * is ISC-283's shape exactly. The inversion itself is ISC-293's and
     * ISC-297's: a bound sitting inside what it bounds.
     */
    gateBudget([10_000]),
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
    gateBudget([10_000]),
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
    gateBudget([10_000]),
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
    gateBudget([10_000, 10_000]),
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

/**
 * ISC-248 — the refresher RUNS on the supervisor's lifecycle and RE-INJECTS.
 *
 * `TokenRefresher` was unit-proved and callerless for two phases: the class
 * knew when to fire and what to do, and nothing ever constructed one, so the
 * criterion's verb had no evidence and could have none. Its unit tests drive
 * `tick()` against a fake clock — which is the right way to pin the schedule
 * and structurally cannot answer "does a real supervisor start one".
 *
 * So this probe uses a real supervisor process, a real container, and a real
 * federated credential, with `token_refresh` compressed to seconds. The
 * compression is the only thing faked, and it is faked in CONFIG — the same
 * field an operator sets — rather than by reaching into the refresher.
 *
 * WHAT IS ASSERTED, and why not the obvious thing: NOT that the token VALUE
 * changed between generations. `gcloud auth application-default
 * print-access-token` serves a cached token until it nears expiry, so two
 * mints seconds apart legitimately return identical bytes, and asserting
 * inequality would be asserting a property of gcloud's cache rather than of
 * this loop. What is asserted is that a SECOND injection happened at all —
 * generation 1 in `credentials.jsonl` — which is the fact no unit test and no
 * single state field can carry. ISC-47 separately proves a fresh token
 * reaches gcloud inside the container.
 */
const ADC_PRESENT = await Bun.file(hostAdcFile()).exists();
if (DOCKER && !ADC_PRESENT) {
  console.warn(
    `[skip] the ISC-248 refresh-loop probe needs ${hostAdcFile()}. ` +
      `Run 'gcloud auth application-default login' to include it.`,
  );
}

describe.skipIf(!DOCKER || !ADC_PRESENT)("the supervisor runs the credential refresher", () => {
  test(
    "a compressed token_refresh produces a SECOND injection, not just an initial one (ISC-248)",
    async () => {
      const { root, runId } = await plantRun();
      const run = runPaths(runId, root);
      const wp = workerPaths(run, "eng-1");
      const name = `pifleet-${runId}-cred`;

      // The container is started here rather than by the supervisor because
      // this probe is about the REFRESHER, not about launching: the launch
      // record's argv below is a long-lived no-op child, so a failure here
      // cannot be a container that never came up.
      const start = Bun.spawn(
        ["docker", "run", "-d", "--rm", "--name", name, "alpine:latest", "sleep", "300"],
        { stdout: "ignore", stderr: "pipe" },
      );
      const startErr = await new Response(start.stderr).text();
      expect(await start.exited, `docker run failed: ${startErr}`).toBe(0);
      cleanups.push(async () => {
        Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" });
      });

      const dir = await mkdtemp(join(tmpdir(), "cl-cred-"));
      cleanups.push(() => rm(dir, { recursive: true, force: true }));
      const { bin } = await plantRecorder(dir);

      await writeJsonAtomic(
        wp.launchJson,
        WorkerLaunchSchema.parse({
          kind: "container",
          argv: [bin],
          container: name,
          image: "alpine:latest",
          // Two seconds, so a second injection is due almost immediately.
          // The interval is the ONLY compressed value; mint and inject are
          // the production functions against a live credential.
          credential: {
            mode: "token",
            impersonate_service_account: null,
            quota_project: null,
            refresh_s: 2,
          },
        }),
      );

      await launch(root, runId, { ...process.env, PIFLEET_RUNS_DIR: root } as Record<string, string>);

      // Generation 1 is the whole assertion: generation 0 alone would prove
      // only that something injected once at startup.
      const deadline = performance.now() + 60_000;
      let records: Array<Record<string, unknown>> = [];
      for (;;) {
        const text = await readFile(wp.credentialsJsonl, "utf8").catch(() => "");
        records = text
          .split("\n")
          .filter((l) => l.trim() !== "")
          .map((l) => JSON.parse(l) as Record<string, unknown>);
        if (records.length >= 2) break;
        if (performance.now() > deadline) break;
        await new Promise((r) => setTimeout(r, 250));
      }

      const log = await readFile(wp.supervisorLog, "utf8").catch(() => "(no supervisor log)");
      expect(
        records.length,
        `fewer than two injections in ${wp.credentialsJsonl}. supervisor log:\n${log}`,
      ).toBeGreaterThanOrEqual(2);
      expect(records.map((r) => r["generation"])).toEqual([0, 1]);
      // The record must never be able to carry the token itself.
      for (const r of records) {
        expect(Object.keys(r)).not.toContain("token");
        expect(r["refresh_token_absent"]).toBe(true);
      }

      // The state file is what `status` reads, and it must agree.
      const state = JSON.parse(await readFile(wp.stateJson, "utf8")) as {
        credential: { generation: number; injections: number; degraded: boolean } | null;
      };
      expect(state.credential, "state.json carries no credential health").not.toBeNull();
      expect(state.credential!.generation).toBeGreaterThanOrEqual(1);
      expect(state.credential!.degraded).toBe(false);

      // And the token actually reached the container's tmpfs.
      const cat = Bun.spawn(["docker", "exec", name, "cat", TOKEN_FILE], {
        stdout: "pipe",
        stderr: "pipe",
      });
      const body = (await new Response(cat.stdout).text()).trim();
      expect(await cat.exited, `no token file in the container`).toBe(0);
      expect(body.length, "the injected token file is empty").toBeGreaterThan(0);
    },
    /**
     * ISC-274: the literal is KEPT, and here is what it was compared against.
     *
     * Four spawn call sites are reachable (`docker run`, the supervisor
     * launch, `docker exec cat`, and the recorder child), so `cliBudget(4)`
     * would be the mechanical answer — and it does NOT govern, because
     * process startup is not what this probe waits on. The wait is two REAL
     * `gcloud auth application-default print-access-token` round-trips to
     * Google, separated by the 2s refresh interval, plus the container's own
     * start. Measured warm at 4.0s end to end; the ceiling covers a slow or
     * retrying token endpoint on a cold CI runner, the same derivation and
     * the same 120_000 as adc.test.ts's live-credential probes, which wait on
     * the identical round-trip.
     */
    120_000,
  );
});
