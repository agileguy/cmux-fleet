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
 *
 * An absence assertion is only worth what its matcher catches, and the first
 * spelling of this one caught less than it claimed. `expect(argv).not.toContain
 * ("-p")` compares whole ARRAY ELEMENTS, so it sees `["-p", "8080:8080"]` and
 * misses `["-p8080:8080"]` and `["--publish=8080:8080"]` — both of which are
 * valid `docker run`, and the combined form is the one a hand-edit is likeliest
 * to introduce. A hostile argv carrying `--publish=8080:8080`, `-p9090:9090`
 * and `--network=host` passed every assertion in this file, positive controls
 * included. The predicates below match per-ELEMENT PREFIXES instead, and
 * `describe("the port predicates")` runs that same hostile argv through them so
 * the matcher is tested rather than trusted.
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
 * flooder does. A quiet worker finishing while the floods are still in
 * progress cannot be explained by an event loop the floods were blocking.
 *
 * **Both ends of that interval are stamped by the SUPERVISOR**, and that is a
 * correction, not a detail. The first spelling stamped `dispatchedAt` after the
 * dispatch CLI subprocess had fully exited — pipes drained, process reaped —
 * which puts `writeJsonAtomic`'s real fsync calls and a ledger append INSIDE
 * the measured window, i.e. exactly the loaded-runner noise the measurement
 * exists to exclude. It was already wrong rather than merely fragile: the quiet
 * script has a fixed 50ms delay, so no honest quiet latency can be under 50ms,
 * and a local unloaded run measured 35ms, 35ms and 49ms. Worse, the poller runs
 * CONCURRENTLY with the dispatches, so under load `settledAt` could be stamped
 * before `dispatchedAt` and the headline ordering could pass on a negative
 * latency — a silent false pass that would hide a real starvation regression.
 *
 * So `startedAt` is the `epoch_started` record the supervisor writes to its own
 * `events.jsonl` when it binds `agent_start` to the live epoch, and `settledAt`
 * is the `settled_at` field the supervisor writes into the task record inside
 * `settle()`. Both come from one process's clock, on the far side of the
 * control socket, so neither can be moved by how busy this test RUNNER is.
 *
 * They CAN be moved by how busy the SUPERVISOR is, which is a different thing
 * and is not a flaw in the choice of endpoints — it is the residual error that
 * `QUIET_SKEW_MS` below exists to absorb. See the comment on that constant.
 * A floor on `min(quiet)` is kept as a cheap backstop: it is close to the
 * arithmetic floor the scenario guarantees, and it FAILED on the measurement
 * this replaces.
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
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { EXIT } from "../../src/contracts.ts";
import { loadConfig } from "../../src/config/load.ts";
import { renderAllWorkers } from "../../src/config/render.ts";
import { workerContainerName } from "../../src/attended/mode.ts";
import {
  runPaths,
  socketPath,
  taskRecordPath,
  workerPaths,
  type RunPaths,
} from "../../src/run/paths.ts";
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

/**
 * The scripted delay inside every quiet worker's turn, from the scenario.
 *
 * It is the arithmetic FLOOR on an honestly-measured quiet latency: the
 * supervisor cannot see `agent_end` before the double has slept this long, and
 * settling additionally costs two `get_state` round trips. A measurement that
 * comes in under it is measuring something other than the interval it names.
 */
const QUIET_TURN_DELAY_MS = 50;

/**
 * Processing-time skew allowed under the floor, and why the floor is not 50.
 *
 * The scripted 50 ms sleep happens in the CHILD, between writing `agent_start`
 * and writing `agent_end`. Both ends of the measured interval are stamped when
 * the SUPERVISOR processes those events, not when the child emitted them, so
 * the measurement is the child's 50 ms plus (or minus) however differently the
 * supervisor was delayed reaching each end.
 *
 * That difference is not symmetric here, and this test is what makes it so: at
 * the moment a quiet turn starts, the supervisor is draining ~1.6 MB from two
 * flooding workers, so it can reach `agent_start` LATE; by the time
 * `agent_end` lands 50 ms later it may have caught up and reach that one
 * promptly. A late start and a prompt end shorten the interval, and the
 * measurement comes in a few milliseconds UNDER the sleep that really happened.
 *
 * This is not hypothetical and was not found by reasoning: CI measured
 * **47 ms** against a floor of 50 and failed, on a run whose only new content
 * was an unrelated test file. Nothing was wrong with the fleet — the turn slept
 * its 50 ms, and the assertion was reading the clock at two moments the
 * scenario deliberately loads.
 *
 * 10 ms is chosen to be far wider than that skew and still tight enough to keep
 * the backstop's job. State the cost plainly rather than round it off: the
 * measurement this file replaced reported 35 ms, 35 ms and 49 ms, and a 40 ms
 * floor catches the first two where a 50 ms floor caught all three. The floor
 * is therefore genuinely WEAKER against a near-miss understatement, and that is
 * the price of not reporting this test's own load as a product failure.
 *
 * It is an acceptable price here only because the floor is a backstop and not
 * the measurement: the defect those three numbers came from was stamping the
 * start AFTER the dispatch subprocess had exited, and that spelling is gone —
 * both endpoints are now supervisor-side and cannot include a CLI's teardown at
 * all. The floor guards against a future regression re-introducing a shortened
 * window, and two of the three known samples still trip it. If a 49 ms-class
 * regression is ever a live worry, the fix is a tighter measurement, not a
 * floor tuned so finely that runner load decides whether main is green.
 */
const QUIET_SKEW_MS = 10;

/** The floor an honest quiet latency clears even at worst-case stamping skew. */
const QUIET_LATENCY_FLOOR_MS = QUIET_TURN_DELAY_MS - QUIET_SKEW_MS;

/** Budget for the flooded `events.jsonl` to finish draining before it is counted. */
const DRAIN_BUDGET_MS = 30_000;

const cleanups: string[] = [];

/**
 * The live fleet's runs root, registered BEFORE `up` is asserted on.
 *
 * This used to be assigned from `up`'s parsed JSON, one line AFTER
 * `expect(up.code).toBe(EXIT.SUCCESS)` — so the two ways `up` legitimately
 * fails LATE, having already launched every supervisor (`worker <id> died
 * during startup`, and the 60s idle-gate timeout, both in `up.ts`), threw
 * before it was set, `afterAll` saw `null`, and sixteen detached supervisors
 * plus their fake-pi children were never reaped. That is not hypothetical:
 * stale `pifleet daemon --run` processes from earlier runs of this suite were
 * found on the development machine.
 *
 * It holds the ROOT rather than a run id, and cleanup enumerates the directory,
 * because on those same failure paths `up` never prints the JSON line that the
 * run id was being read out of. A teardown that depends on the output of the
 * command whose failure it is cleaning up after is not a teardown.
 */
let liveFleet: { root: string; env: Record<string, string> } | null = null;

/** `rm -rf` over many trees, at a bounded width — sixteen at once is a thundering herd. */
async function removeAll(dirs: readonly string[], concurrency = 4): Promise<void> {
  const queue = [...dirs];
  const lanes = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
    for (;;) {
      const dir = queue.shift();
      if (dir === undefined) return;
      await rm(dir, { recursive: true, force: true }).catch(() => {});
    }
  });
  await Promise.all(lanes);
}

afterAll(async () => {
  // Belt and braces: the live test downs its own fleet, but a failure part-way
  // must not leave sixteen supervisors outliving the suite. Unconditional
  // rather than skipped on the happy path — `down` on an already-down run is a
  // no-op, and "we think we already cleaned up" is what left the processes.
  if (liveFleet !== null) {
    const { root, env } = liveFleet;
    let runIds: string[] = [];
    try {
      runIds = (await readdir(root)).filter((e) => !e.startsWith("."));
    } catch {
      // The root never got created; there is nothing running to reap.
    }
    for (const runId of runIds) {
      await cli(env, ["down", "--run", runId, "--json"]).catch(() => {});
    }
  }
  await removeAll(cleanups);
  // Sixteen workers' run directories are a lot of inodes, and `down` ahead of
  // them talks to sixteen control sockets. The 5s default is not enough to
  // finish, and a teardown killed mid-flight is the leak this exists to close.
}, 120_000);

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

/** Every spelling Docker accepts for publishing or exposing a port. */
const PUBLISH_FLAGS = ["-p", "--publish", "-P", "--publish-all", "--expose"] as const;

/**
 * Every element of `argv` that publishes or exposes a port, in ANY spelling.
 *
 * Three forms, because Docker accepts three and a matcher that knows one is an
 * absence assertion with a hole in it:
 *   - separated  `["--publish", "8080:8080"]`, `["-p", "8080:8080"]`
 *   - `=`-joined `["--publish=8080:8080"]`
 *   - short-combined `["-p8080:8080"]`, `["-p127.0.0.1:8080:8080"]`
 *
 * `-p` is matched combined only when a DIGIT follows, which is what a port
 * spec always starts with (an ip, a host port, or `[::1]`-style brackets are
 * all preceded by digits or handled by the `=` form). Without that guard the
 * pattern would swallow unrelated long flags; with it, `--pids-limit` — which
 * this argv really does carry — is untouched, since it begins `--p`, not `-p`.
 *
 * Returns the offenders rather than a boolean so a failure names the flag it
 * found instead of asserting that `false` should have been `true`.
 */
export function publishFlagsIn(argv: readonly string[]): string[] {
  return argv.filter((a) =>
    PUBLISH_FLAGS.some(
      (f) => a === f || a.startsWith(`${f}=`) || (f === "-p" && /^-p\d/.test(a)),
    ),
  );
}

/**
 * Every network `argv` attaches to, in both spellings.
 *
 * `--network host` is two elements and `--network=host` is one, and only the
 * first was being read — so the one way "no publish flag" could still mean
 * "sixteen workers sharing the host's entire port space" was checkable but
 * unchecked. `--net` is Docker's accepted alias for the same thing and is read
 * here for the same reason: the assertion is about what Docker would DO.
 */
export function networkValues(argv: readonly string[]): string[] {
  const found: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === "--network" || a === "--net") {
      const value = argv[i + 1];
      if (value !== undefined) found.push(value);
    } else if (a.startsWith("--network=")) found.push(a.slice("--network=".length));
    else if (a.startsWith("--net=")) found.push(a.slice("--net=".length));
  }
  return found;
}

/**
 * The supervisor's own timestamp for the moment worker `w` began its turn.
 *
 * `epoch_started` is written by the supervisor from inside `onEvent`, the
 * instant it binds an `agent_start` to the live epoch — which is the first
 * moment the dispatch has demonstrably become WORK rather than an accepted
 * message. Reading it here rather than stamping a clock in this process is the
 * whole point: nothing between the control-socket reply and this record runs on
 * the test runner, so a loaded runner cannot inflate it.
 *
 * `null` when the record is absent, and the caller must treat that as a
 * failure rather than a zero — a worker whose epoch never opened is the
 * starvation this file is about, and defaulting it would score it as instant.
 */
async function epochStartedAt(run: RunPaths, worker: string): Promise<number | null> {
  const path = workerPaths(run, worker).eventsJsonl;
  if (!existsSync(path)) return null;
  for (const line of (await Bun.file(path).text()).split("\n")) {
    // Cheap reject first: a flooder's events file is ~800KB of stderr lines.
    if (line === "" || !line.includes('"epoch_started"')) continue;
    const record = JSON.parse(line) as { type?: string; ts?: string };
    if (record.type === "epoch_started" && typeof record.ts === "string") {
      return Date.parse(record.ts);
    }
  }
  return null;
}

/**
 * Read `path` until it holds `atLeast` occurrences of `needle`, or time out.
 *
 * The supervisor appends to `events.jsonl` through a serialized promise chain
 * that nothing in the CLI awaits, so a flooder's last noise lines can still be
 * in flight when its task record already exists. A single read raced that chain
 * and would have failed the anti-vacuity count for a flood that did happen —
 * the wrong failure, and an intermittent one. Returns whatever it has at the
 * deadline so the assertion, not this helper, reports the shortfall.
 */
async function readUntilCount(
  path: string,
  needle: string,
  atLeast: number,
  budgetMs: number,
): Promise<string> {
  const start = performance.now();
  for (;;) {
    const text = await Bun.file(path).text();
    if (text.split(needle).length - 1 >= atLeast) return text;
    if (performance.now() - start > budgetMs) return text;
    await new Promise((r) => setTimeout(r, 25));
  }
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

/**
 * Rendering sixteen workers writes and reads sixteen worker directories, and on
 * a loaded machine that is slower than bun's 5s default allows — a run under
 * moderate synthetic load timed these out at the default. The budget below is
 * not a performance claim; it is generous on purpose, so that a timeout here
 * means "wedged", never "busy".
 */
const RENDER_TEST_TIMEOUT_MS = 30_000;

describe("ISC-158: sixteen workers collide on nothing", () => {
  test(
    "sixteen rendered workers carry sixteen distinct container names, spelled the same way in both places",
    async () => {
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

    /**
     * The Pi-agent volume is the other per-worker named resource, and it does
     * not collide across this fleet: sixteen workers, sixteen volume names.
     *
     * What it is NOT is run-scoped. `buildDockerArgv` names it
     * `pifleet-piagent-<worker>` with no run id in it, so two concurrent fleets
     * that both define `eng-1` share one Docker volume mounted at
     * `/home/pi/.pi/agent` — the state a worker keeps between turns. That is
     * outside ISC-158, which is about collision WITHIN a fleet, and fixing it
     * means changing a production path and whatever reaps those volumes; it is
     * left as a finding rather than smuggled in here. This assertion pins the
     * property that does hold, so a regression in it is caught, and names the
     * one that does not, so the gap is not silent.
     */
    const agentVolumes = rendered.map((r) => {
      const hits = r.docker.filter((a) => a.startsWith("pifleet-piagent-"));
      expect(hits).toHaveLength(1);
      return hits[0]!;
    });
    expect(new Set(agentVolumes).size).toBe(16);
    },
    RENDER_TEST_TIMEOUT_MS,
  );

  test(
    "no worker publishes a port, so sixteen workers have no port to collide on",
    async () => {
      const loaded = await renderFixture();
      const rendered = await renderAllWorkers(loaded, { runId: "2026-08-18T00-00-00Z-abcd" });
      expect(rendered).toHaveLength(16);

      for (const r of rendered) {
        // Not "contains no element equal to `-p`" — every spelling Docker
        // would act on. See `publishFlagsIn`.
        expect(publishFlagsIn(r.docker)).toEqual([]);

        // `--network host` would reach the host's port space without any
        // publish flag at all, which is the one way "no publish flag" could
        // still mean "sixteen workers on one port space". Read in both
        // spellings, and asserted over every network the argv names.
        const networks = networkValues(r.docker);
        expect(networks).not.toContain("host");

        // POSITIVE CONTROL, or the assertions above are satisfied by an empty
        // array. This is a real `docker run` argv: it names the container,
        // attaches it to the fleet's shared network, and ends in the Pi flags.
        expect(r.docker.slice(0, 2)).toEqual(["docker", "run"]);
        expect(networks).toHaveLength(1);
        expect(typeof networks[0]).toBe("string");
        expect(r.docker).toContain("--mode");
      }
    },
    RENDER_TEST_TIMEOUT_MS,
  );
});

/**
 * The matcher, tested rather than trusted.
 *
 * These predicates are the entire content of the "no port surface" claim, so a
 * hole in them is a hole in the claim — and the first version had one that the
 * suite could not see, because a passing absence assertion looks identical
 * whether it is checking something or nothing. The fixture below is a REAL
 * `docker run` argv carrying the three things the claim forbids, in the
 * spellings the old matcher missed. Every assertion here fails if the
 * predicates regress to element equality.
 */
describe("ISC-158: the port predicates catch what they claim to catch", () => {
  /** Valid `docker run`, and hostile: two publish spellings plus host networking. */
  const HOSTILE = [
    "docker",
    "run",
    "--name",
    "pifleet-run-eng-1",
    "--pids-limit", // the near-miss `/^-p\d/` must not fire on
    "512",
    "--publish=8080:8080",
    "-p9090:9090",
    "--network=host",
    "image:tag",
    "--mode",
    "rpc",
  ];

  test("both combined publish spellings are found, and --pids-limit is not", () => {
    expect(publishFlagsIn(HOSTILE)).toEqual(["--publish=8080:8080", "-p9090:9090"]);
  });

  test("the separated and short-combined spellings are found too", () => {
    expect(publishFlagsIn(["-p", "8080:8080"])).toEqual(["-p"]);
    expect(publishFlagsIn(["--publish", "8080:8080"])).toEqual(["--publish"]);
    expect(publishFlagsIn(["-p127.0.0.1:8080:8080"])).toEqual(["-p127.0.0.1:8080:8080"]);
    expect(publishFlagsIn(["-P"])).toEqual(["-P"]);
    expect(publishFlagsIn(["--publish-all"])).toEqual(["--publish-all"]);
    expect(publishFlagsIn(["--expose=8080"])).toEqual(["--expose=8080"]);
  });

  test("a clean argv yields no false positives", () => {
    expect(publishFlagsIn(["docker", "run", "--pids-limit", "512", "--cpus", "2"])).toEqual([]);
  });

  test("host networking is read in both spellings", () => {
    expect(networkValues(HOSTILE)).toEqual(["host"]);
    expect(networkValues(["--network", "host"])).toEqual(["host"]);
    expect(networkValues(["--net=host"])).toEqual(["host"]);
    expect(networkValues(["--network", "pifleet-egress"])).toEqual(["pifleet-egress"]);
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

      // Teardown is armed BEFORE anything is launched, and it is armed with the
      // ROOT rather than a run id. `up` launches all sixteen supervisors and
      // only THEN waits for them to go idle, so both of its late failures —
      // a worker dying during startup, and the 60s idle gate — leave sixteen
      // detached processes behind while printing no JSON to read a run id out
      // of. Assigning this after the assertions below is what leaked them.
      liveFleet = { root, env };

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
      // The CLI is still the dispatcher — its exit-code ladder and JSON are
      // part of the contract this file tests. What has changed is that NO
      // timing is taken from it. `cli()` resolves only once the subprocess has
      // exited, and between the supervisor's ack and that exit sit
      // `writeJsonAtomic`'s fsyncs and a ledger append; stamping a clock here
      // put all of it inside the measured interval.
      const taskIdFor = (worker: string): string => `T-${worker}`;
      /** Supervisor-stamped `settled_at`, in epoch ms — never this process's clock. */
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
        expect(d.code).toBe(EXIT.SUCCESS);
        const dj = json<{ accepted: boolean; epoch: number }>(d);
        expect(dj.accepted).toBe(true);
        expect(dj.epoch).toBe(1);
      });

      /**
       * `allSettled`, not `all`.
       *
       * These sixteen promises carry `expect` calls, and `Promise.all` rejects
       * on the first one that throws. The poller below is a detached promise
       * awaited afterwards, so an early rejection propagated out of the test
       * body while the poller was still running its 90s budget — the loop kept
       * reading task records from a run the test had already abandoned. Every
       * outcome is collected, the poller is always awaited, and the first
       * failure is re-thrown once nothing is left running.
       */
      // Filled in one shot when every dispatch has settled; empty until then,
      // which is exactly what the poller's early-exit check wants to read.
      const dispatchOutcomes: PromiseSettledResult<void>[] = [];
      const dispatchesDone = Promise.allSettled(dispatches).then((r) => {
        dispatchOutcomes.push(...r);
      });

      // Poll every worker's task record concurrently with the dispatches. The
      // record is written by `settle` and awaited there, so its appearance is
      // the settle — and `settled_at` inside it is the supervisor's own stamp
      // for that moment, which is what the measurement uses. The poll interval
      // decides only how soon this loop NOTICES, never what it records.
      const pollBudgetMs = 90_000;
      const poller = (async () => {
        const start = performance.now();
        while (settledAt.size < WORKERS.length && performance.now() - start < pollBudgetMs) {
          await Promise.all(
            WORKERS.map(async (worker) => {
              if (settledAt.has(worker)) return;
              const wp = workerPaths(run, worker);
              const rec = await readTaskRecord(taskRecordPath(wp, taskIdFor(worker)));
              if (rec !== null) settledAt.set(worker, Date.parse(rec.settled_at));
            }),
          );
          if (settledAt.size === WORKERS.length) break;
          // A dispatch that threw is never going to settle. Waiting out the
          // full budget for it would turn a one-line assertion failure into a
          // ninety-second one and bury the actual cause.
          if (dispatchOutcomes.some((r) => r.status === "rejected")) break;
          await new Promise((r) => setTimeout(r, 25));
        }
      })();

      await dispatchesDone;
      await poller;
      const rejected = dispatchOutcomes.find((r) => r.status === "rejected");
      if (rejected !== undefined) throw rejected.reason;
      expect(settledAt.size).toBe(16);

      // ---- The other end of the interval, also supervisor-stamped.
      //
      // Collected after every worker has settled, so the record is certain to
      // be on disk. A missing `epoch_started` is a hard failure, not a zero:
      // it would mean a dispatch was accepted and never became a turn, which
      // is precisely the wedge this file exists to detect.
      const startedAt = new Map<string, number>();
      for (const worker of WORKERS) {
        const at = await epochStartedAt(run, worker);
        if (at === null) {
          throw new Error(
            `${worker} has no epoch_started in events.jsonl: its dispatch was accepted ` +
              `but never opened an epoch, so it never actually ran a turn`,
          );
        }
        startedAt.set(worker, at);
      }

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
      // Polled to a deadline rather than read once: the supervisor's
      // `events.jsonl` appends run on a chain nothing here awaits, so the last
      // noise lines can still be in flight when the task record already exists.
      const stderrEvents = await readUntilCount(
        workerPaths(run, "eng-1").eventsJsonl,
        '"stderr_line"',
        NOISE_LINES,
        DRAIN_BUDGET_MS,
      );
      expect(stderrEvents.split('"stderr_line"').length - 1).toBeGreaterThanOrEqual(NOISE_LINES);
      expect(stderrEvents.length).toBeGreaterThan((NOISE_LINES * NOISE_BYTES) / 2);

      const stdoutEvents = await readUntilCount(
        workerPaths(run, "eng-2").eventsJsonl,
        '"message_update"',
        NOISE_LINES,
        DRAIN_BUDGET_MS,
      );
      expect(stdoutEvents.split('"message_update"').length - 1).toBeGreaterThanOrEqual(NOISE_LINES);
      expect(stdoutEvents.length).toBeGreaterThan((NOISE_LINES * NOISE_BYTES) / 2);

      // ---- The criterion itself.
      //
      // Both endpoints are the supervisor's, so this is an interval measured
      // entirely on the far side of the control socket. It cannot go negative
      // the way the old `settledAt - dispatchedAt` could when the poller
      // observed a settle before the dispatch CLI had finished exiting.
      const latency = (worker: string): number => settledAt.get(worker)! - startedAt.get(worker)!;
      const quiet = QUIET.map(latency);
      const noisy = NOISY.map(latency);
      const slowestQuiet = Math.max(...quiet);
      const fastestNoisy = Math.min(...noisy);

      /**
       * The arithmetic floor, as a backstop on the measurement itself.
       *
       * A quiet turn contains a scripted 50ms sleep before its `agent_end`, and
       * settling costs two further `get_state` round trips, so no honest quiet
       * latency can be meaningfully below 50ms — less `QUIET_SKEW_MS` for the
       * supervisor-side stamping error that this test's own floods induce, for
       * which see that constant. This assertion is not decorative: on the
       * measurement it replaces it FAILED, reporting 35ms — which is how the
       * old timing was shown to be wrong rather than merely fragile, and which
       * still fails at this floor.
       */
      for (const worker of QUIET) {
        expect(latency(worker)).toBeGreaterThanOrEqual(QUIET_LATENCY_FLOOR_MS);
      }
      expect(Math.min(...quiet)).toBeGreaterThanOrEqual(QUIET_LATENCY_FLOOR_MS);

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
      // `liveFleet` is deliberately NOT cleared here. Clearing it would make
      // the sweep in `afterAll` conditional on this line being reached, which
      // is the same shape as the bug it exists to close; a second `down` on an
      // already-down run costs a second and reaps anything this one missed.
    },
    180_000,
  );
});
