/**
 * ISC-158 at full width: sixteen workers, no collision, no starvation.
 *
 * The criterion names three properties, and they are not the same kind of
 * claim, so they are not proved the same way.
 *
 * **Container names** are a pure function of `(run_id, worker_id)` and are
 * built in two places — `buildDockerArgv` for `docker run --name` and
 * `workerContainerName` for `docker exec` into an attended pane, which
 * `attended/mode.ts` duplicates on purpose and flags as consolidation debt.
 * Sixteen distinct names is therefore checked by RENDERING sixteen workers
 * rather than by starting sixteen containers: `render` exists precisely so the
 * argv can be inspected without a Docker daemon (ISC-60), and a live run would
 * prove the same function with a Docker dependency bolted on. Both spellings
 * are compared against each other for all sixteen, because a divergence
 * between them is a collision in every sense that matters — two subsystems
 * addressing what they each believe is one container.
 *
 * **Ports have no collision surface at all**, and saying so is the finding.
 * Nothing in pifleet allocates a TCP or UDP port per worker: `buildDockerArgv`
 * emits no `-p`/`--publish`/`-P`/`--expose` on any branch, `DockerSchema` is
 * `.strict()` with no port key and no raw-argv passthrough, the Dockerfile has
 * no `EXPOSE`, and every worker attaches to one shared `--internal` network.
 * The per-worker addressable resource that a port WOULD have been is a UNIX
 * domain socket (`Bun.listen({unix})`), named by `sha256(run_id, worker_id)`
 * rather than allocated from a range (`run/paths.ts`). So the honest test is
 * not "sixteen ports do not collide" — there is nothing to test that on — it
 * is that the surface stays absent, plus the socket-uniqueness property that
 * actually carries the weight. Both are asserted below. If a future phase
 * publishes a port, the absence assertion fails and this comment is what tells
 * the next reader why it existed.
 *
 * **Starvation is behavioural** and needs a live fleet. Sixteen real
 * supervisors run against the `pifleet-fake-pi` double on the `headless`
 * backend — no Docker, no network, no GUI, same conventions as
 * `lifecycle.test.ts` and `backend-equivalence.test.ts`, and cheap enough for
 * the fast `test` CI job. Two of the sixteen flood a pipe with ~800KB (twelve
 * times the ~64KB at which an undrained pipe blocks the child, SRD §3.4 rule
 * 2) paced over ~1.6s; the other fourteen run 50ms turns. The assertion is an
 * ORDERING, not a stopwatch: every quiet worker must settle before either
 * flooder does, measured from its own dispatch ack so a slow CLI spawn on a
 * loaded runner cannot masquerade as starvation. A quiet worker finishing
 * while the floods are still in progress cannot be explained by an event loop
 * the floods were blocking.
 *
 * Two guards keep that from passing vacuously. The floods are verified to have
 * actually happened — the drained bytes are counted out of `events.jsonl`, so
 * a `noise` entry that silently no-ops fails the test rather than making it
 * trivially green. And the flooders must settle TOO: if they wedged, the drain
 * is broken, and "the quiet ones were fine" would be describing a fleet that
 * lost two workers.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { EXIT } from "../../src/contracts.ts";
import { loadConfig } from "../../src/config/load.ts";
import { renderAllWorkers } from "../../src/config/render.ts";
import { workerContainerName } from "../../src/attended/mode.ts";
import { runPaths, socketPath, taskRecordPath, workerPaths } from "../../src/run/paths.ts";
import { readTaskRecord } from "../../src/run/state.ts";
import { controlCall } from "../../src/supervisor/launch.ts";

const ROOT_URL = new URL("../../", import.meta.url).pathname;
const CLI = join(ROOT_URL, "src/cli/index.ts");
const FAKE_PI = join(ROOT_URL, "test/fixtures/fake-pi.ts");
const SCENARIO = join(ROOT_URL, "test/fixtures/scenarios/noisy-fleet.json");

/** The fleet. Sixteen is the criterion's number, and the schema's cap is 64. */
const WORKERS = Array.from({ length: 16 }, (_, i) => `eng-${i + 1}`);
/** The two the `noisy-fleet` scenario scripts to flood a pipe, by session id. */
const NOISY = ["eng-1", "eng-2"] as const;
const QUIET = WORKERS.filter((w) => !(NOISY as readonly string[]).includes(w));

/**
 * Lines each flooder emits, straight from the scenario. Duplicated as a
 * constant so the anti-vacuity assertions compare the DRAINED count against
 * the scripted one; reading it back out of the fixture would compare the
 * fixture with itself.
 */
const NOISE_LINES = 2000;
/** Filler width per noise line, also from the scenario. */
const NOISE_BYTES = 400;

/**
 * The floods are paced over roughly this long. Used only as a floor: a flooder
 * settling faster than this would mean the noise never really happened, which
 * would make the ordering assertion meaningless rather than satisfied.
 */
const FLOOD_FLOOR_MS = 1_000;

/** Absolute ceiling on a quiet worker's dispatch→settle, as a second net. */
const QUIET_DEADLINE_MS = 10_000;

const cleanups: string[] = [];
let liveRun: { root: string; runId: string; env: Record<string, string> } | null = null;

afterAll(async () => {
  // Belt and braces: the live test downs its own fleet, but a failure part-way
  // must not leave sixteen supervisors outliving the suite.
  if (liveRun !== null) {
    await cli(liveRun.env, ["down", "--run", liveRun.runId, "--json"]).catch(() => {});
  }
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** The CLI as a real subprocess — the exit-code ladder is part of the contract. */
async function cli(env: Record<string, string>, args: string[]): Promise<CliResult> {
  const proc = Bun.spawn([process.execPath, CLI, ...args], {
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}

function json<T>(r: CliResult): T {
  return JSON.parse(r.stdout.trim()) as T;
}

function valueOf(argv: readonly string[], flag: string): string | undefined {
  const i = argv.indexOf(flag);
  return i === -1 ? undefined : argv[i + 1];
}

/**
 * A sixteen-worker config in its own temp dir, so every rendered path is
 * fixture-relative and nothing encodes one machine's home directory.
 *
 * The worker ids are the SAME sixteen the live fleet runs, which is what makes
 * the rendered-name half and the live half statements about one fleet rather
 * than two coincidentally-sized ones. Role is irrelevant to the name template
 * (`pifleet-<run>-<worker>`), so one role keeps the fixture honest about what
 * is being varied: the worker id, sixteen times.
 */
async function renderFixture(): Promise<Awaited<ReturnType<typeof loadConfig>>> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-scale16-cfg-"));
  cleanups.push(dir);
  await mkdir(join(dir, "roles"), { recursive: true });
  await writeFile(join(dir, "roles", "eng.md"), "Engineer role briefing.\n");
  await writeFile(
    join(dir, "fleet.yaml"),
    stringify({
      version: 2,
      name: "scale-16",
      docker: { pi_version: "0.79.6" },
      run: { root: "./runs", repo: ".", budget: { tokens_ceiling: 1_000_000 } },
      llm: { model: "DefaultModel" },
      roles: {
        eng: {
          model: "Qwen3-Coder-30B-A3B-Instruct-4bit",
          toolchain: "node",
          tools: ["read", "write", "edit", "bash", "grep", "find", "ls"],
          append_system_prompt_file: "./roles/eng.md",
        },
      },
      workers: WORKERS.map((id) => ({ id, role: "eng" })),
    }),
  );
  return loadConfig(join(dir, "fleet.yaml"));
}

describe("ISC-158: sixteen workers collide on nothing", () => {
  test("sixteen rendered workers carry sixteen distinct container names, spelled the same way in both places", async () => {
    const loaded = await renderFixture();
    const runId = "2026-08-18T00-00-00Z-abcd";
    const rendered = await renderAllWorkers(loaded, { runId });
    expect(rendered).toHaveLength(16);

    const names = rendered.map((r) => valueOf(r.docker, "--name"));
    // Anti-vacuity: every argv must actually CARRY a `--name`. Sixteen
    // `undefined`s are also "distinct" to a Set of size one, but sixteen
    // containers with no name at all is the collision, not the absence of one.
    for (const name of names) expect(typeof name).toBe("string");
    expect(new Set(names).size).toBe(16);

    for (const r of rendered) {
      // The two spellings, compared. `attended/mode.ts` duplicates the
      // template rather than importing it and says so; nothing else checks
      // that the copy still matches the original for a whole fleet.
      expect(valueOf(r.docker, "--name")).toBe(workerContainerName(runId, r.workerId));
      expect(valueOf(r.docker, "--name")).toBe(`pifleet-${runId}-${r.workerId}`);
    }

    // The control socket is the per-worker addressable resource that a port
    // would have been, and it is derived by hash rather than allocated — so
    // uniqueness is a property of the hash over sixteen inputs, not of a
    // registry that could hand the same value out twice.
    expect(new Set(WORKERS.map((w) => socketPath(runId, w))).size).toBe(16);
  });

  test("no worker publishes a port, so sixteen workers have no port to collide on", async () => {
    const loaded = await renderFixture();
    const rendered = await renderAllWorkers(loaded, { runId: "2026-08-18T00-00-00Z-abcd" });
    expect(rendered).toHaveLength(16);

    // Every spelling Docker accepts for publishing a port.
    const PUBLISH_FLAGS = ["-p", "--publish", "-P", "--publish-all", "--expose"];
    for (const r of rendered) {
      for (const flag of PUBLISH_FLAGS) expect(r.docker).not.toContain(flag);
      // `--network host` would reach the host's port space without any of the
      // flags above, which is the one way "no publish flag" could still mean
      // "sixteen workers on one port space".
      expect(valueOf(r.docker, "--network")).not.toBe("host");

      // POSITIVE CONTROL, or the four assertions above are satisfied by an
      // empty array. This is a real `docker run` argv: it names the container,
      // attaches it to the fleet's shared network, and ends in the Pi flags.
      expect(r.docker.slice(0, 2)).toEqual(["docker", "run"]);
      expect(typeof valueOf(r.docker, "--network")).toBe("string");
      expect(r.docker).toContain("--mode");
    }
  });
});

describe("ISC-158: sixteen live workers, two of them flooding a pipe", () => {
  test(
    "every worker settles, and no quiet worker waits on a flooder's output",
    async () => {
      const base = await mkdtemp(join(tmpdir(), "pifleet-scale16-"));
      cleanups.push(base);
      const root = join(base, "runs");
      await mkdir(root, { recursive: true });
      const env = {
        PIFLEET_RUNS_DIR: root,
        PIFLEET_PI_COMMAND: `${process.execPath} ${FAKE_PI} --scenario ${SCENARIO}`,
      };

      // ---- up: sixteen supervisors, all idle before `up` returns (ISC-70).
      const up = await cli(env, [
        "up",
        "--workers",
        WORKERS.join(","),
        "--backend",
        "headless",
        "--json",
      ]);
      expect(up.code).toBe(EXIT.SUCCESS);
      const upJson = json<{ run_id: string; workers: Array<{ id: string; pid: number }> }>(up);
      const runId = upJson.run_id;
      liveRun = { root, runId, env };
      const run = runPaths(runId, root);

      expect(upJson.workers).toHaveLength(16);
      expect(new Set(upJson.workers.map((w) => w.id)).size).toBe(16);
      // Sixteen distinct supervisor processes. One pid twice would mean two
      // workers sharing an event loop, which is the starvation hazard by
      // construction rather than by load.
      expect(new Set(upJson.workers.map((w) => w.pid)).size).toBe(16);

      // ---- Sixteen control sockets, actually bound and individually correct.
      //
      // This is the EADDRINUSE-equivalent. A second supervisor binding a path
      // the first already holds is what a port collision would be here, and
      // `serveJsonlSocket` unlinks a stale path before binding — so a
      // collision does not fail loudly, it silently redirects one worker's
      // control traffic to another's socket. Asking each socket who it belongs
      // to is what catches that: the reply must name the worker whose path was
      // dialled, not merely answer.
      const sockets = WORKERS.map((w) => workerPaths(run, w).controlSock);
      expect(new Set(sockets).size).toBe(16);
      for (const s of sockets) expect(existsSync(s)).toBe(true);
      const pings = await Promise.all(
        WORKERS.map(async (w) => (await controlCall(run, w, { cmd: "ping" }))["worker"]),
      );
      expect(pings).toEqual(WORKERS);

      // ---- Dispatch all sixteen concurrently.
      //
      // Latency is measured from each worker's OWN dispatch ack, not from a
      // shared t0: sixteen `bun` spawns on a loaded runner skew wall-clock
      // start times by far more than the effect under test, and that skew
      // would read as starvation.
      const taskIdFor = (worker: string): string => `T-${worker}`;
      const dispatchedAt = new Map<string, number>();
      const settledAt = new Map<string, number>();

      const dispatches = WORKERS.map(async (worker) => {
        const taskId = taskIdFor(worker);
        // Task files live BESIDE the runs root, never inside it — the root's
        // listing is how `latestRunId` resolves the default run.
        const taskFile = join(base, `${taskId}.task.json`);
        await writeFile(
          taskFile,
          JSON.stringify({
            task_id: taskId,
            title: `scale ${taskId}`,
            brief: `Perform the scripted work for ${taskId}.`,
            deadline_s: 300,
          }),
        );
        const d = await cli(env, ["dispatch", "--worker", worker, "--task", taskFile, "--json"]);
        dispatchedAt.set(worker, performance.now());
        expect(d.code).toBe(EXIT.SUCCESS);
        const dj = json<{ accepted: boolean; epoch: number }>(d);
        expect(dj.accepted).toBe(true);
        expect(dj.epoch).toBe(1);
      });

      // Poll every worker's task record concurrently with the dispatches, and
      // stamp the first moment each appears. The record is written by `settle`
      // and awaited there, so its appearance is the settle, not a view of it.
      const pollBudgetMs = 90_000;
      const poller = (async () => {
        const start = performance.now();
        while (settledAt.size < WORKERS.length && performance.now() - start < pollBudgetMs) {
          await Promise.all(
            WORKERS.map(async (worker) => {
              if (settledAt.has(worker)) return;
              const wp = workerPaths(run, worker);
              const rec = await readTaskRecord(taskRecordPath(wp, taskIdFor(worker)));
              if (rec !== null) settledAt.set(worker, performance.now());
            }),
          );
          if (settledAt.size < WORKERS.length) await new Promise((r) => setTimeout(r, 25));
        }
      })();

      await Promise.all(dispatches);
      await poller;
      expect(settledAt.size).toBe(16);

      // ---- wait, through the real CLI: sixteen real verdicts, exit 0.
      const w = await cli(env, ["wait", "--run", runId, "--all", "--timeout", "60s", "--json"]);
      const wj = json<{
        exit: number;
        tasks: Array<{ task_id: string; verdict: string; reason: string; epoch: number | null }>;
      }>(w);
      expect(wj.tasks).toHaveLength(16);
      for (const t of wj.tasks) {
        // A real verdict — never `unknown`, which is what a starved or wedged
        // worker produces and is the failure this criterion is about.
        expect(t.verdict).toBe("success");
        expect(t.epoch).toBe(1);
      }
      expect(w.code).toBe(EXIT.SUCCESS);

      // ---- The floods actually happened.
      //
      // Counted out of `events.jsonl`, which is where the supervisor's drain
      // deposits what it read (SRD §3.4 rule 2) — so this measures bytes that
      // made it THROUGH the drain, not bytes the double claims to have
      // written. A `noise` entry that silently no-opped would leave every
      // assertion below trivially satisfiable.
      const stderrEvents = await Bun.file(workerPaths(run, "eng-1").eventsJsonl).text();
      expect(stderrEvents.split('"stderr_line"').length - 1).toBeGreaterThanOrEqual(NOISE_LINES);
      expect(stderrEvents.length).toBeGreaterThan((NOISE_LINES * NOISE_BYTES) / 2);

      const stdoutEvents = await Bun.file(workerPaths(run, "eng-2").eventsJsonl).text();
      expect(stdoutEvents.split('"message_update"').length - 1).toBeGreaterThanOrEqual(NOISE_LINES);
      expect(stdoutEvents.length).toBeGreaterThan((NOISE_LINES * NOISE_BYTES) / 2);

      // ---- The criterion itself.
      const latency = (worker: string): number =>
        settledAt.get(worker)! - dispatchedAt.get(worker)!;
      const quiet = QUIET.map(latency);
      const noisy = NOISY.map(latency);
      const slowestQuiet = Math.max(...quiet);
      const fastestNoisy = Math.min(...noisy);

      // The flooders were genuinely still flooding. Without this, the ordering
      // below could be satisfied by two workers that emitted nothing and
      // happened to finish last.
      expect(fastestNoisy).toBeGreaterThan(FLOOD_FLOOR_MS);

      // Every quiet worker finished before either flooder did — while ~1.6MB
      // was still being pushed through two other workers' pipes. A shared
      // event loop blocked on that output could not produce this ordering.
      expect(slowestQuiet).toBeLessThan(fastestNoisy);
      // And in absolute terms, so a fleet that got uniformly slow is caught
      // too: the ordering alone would survive everything degrading together.
      expect(slowestQuiet).toBeLessThan(QUIET_DEADLINE_MS);

      // ---- status: sixteen workers, all back to idle, all still alive.
      const st = json<{
        workers: Array<{
          id: string;
          alive: boolean;
          phase: string | null;
          pid: number | null;
          completed_epochs: number[];
        }>;
      }>(await cli(env, ["status", "--run", runId, "--json"]));
      expect(st.workers).toHaveLength(16);
      expect(new Set(st.workers.map((x) => x.pid)).size).toBe(16);
      for (const worker of st.workers) {
        expect(worker.alive).toBe(true);
        expect(worker.phase).toBe("idle");
        expect(worker.completed_epochs).toEqual([1]);
      }

      // ---- artifacts: the end-of-fanout call answers for all sixteen.
      const arts = await cli(env, ["artifacts", "--run", runId, "--all", "--json"]);
      expect(arts.code).toBe(EXIT.SUCCESS);
      const aj = json<{ tasks: Array<{ task_id: string; verdict: string }> }>(arts);
      expect(aj.tasks).toHaveLength(16);
      expect(new Set(aj.tasks.map((t) => t.task_id)).size).toBe(16);

      // ---- down: no supervisor outlives the fleet.
      const down = await cli(env, ["down", "--run", runId, "--json"]);
      expect(down.code).toBe(EXIT.SUCCESS);
      expect(json<{ clean: boolean }>(down).clean).toBe(true);
      liveRun = null;
    },
    180_000,
  );
});
