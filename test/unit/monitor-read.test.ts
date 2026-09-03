/**
 * The fleet monitor's data plane (SRD-FLEET-MONITOR §2, §6.3, §6.7, §10).
 *
 * ## ISC-491 is a property of this file, not an aspiration of it
 *
 * §10's closing anti-criterion — "no criterion in this block requires a real
 * terminal" — is the reason `Docs/SRD-TUI-DISPATCH.md` §10 records ISC-377,
 * 378, 379 and 387 sitting at `[~]` indefinitely. So every test below runs
 * against a `mkdtemp` runs root, a fake `docker ps` runner, and pure
 * functions. No terminal is allocated, no container is started, and no fleet
 * is up.
 *
 * **One honest exception, named rather than hidden.** `liveRunIds` calls
 * `processStartTime` (`safety/procstart.ts:122-131`), which spawns `ps` — so
 * the two tests that exercise `readRuns` end to end DO spawn a subprocess.
 * They spawn it against `process.pid`, the test runner's own process, which is
 * why the fixtures record that pid: it is the one pid guaranteed alive and
 * guaranteed to have a start time, so liveness is decided without a fleet.
 * `ps` is neither a terminal, a container, nor a live fleet, and the
 * alternative — stubbing `registry.ts` — would test a double instead of the
 * enumerator the monitor actually calls.
 *
 * ## Why several assertions are made against SOURCE TEXT
 *
 * ISC-469, ISC-471 and ISC-472 are all anti-criteria: they say what the module
 * must never grow, and no behavioural test can observe the absence of a future
 * `docker inspect` or a future local `JSON.parse`. §10 phrases all three as
 * greps for that reason, and `logs.ts`'s own suite already walks source this
 * way. Comments are stripped before every grep, because a criterion that
 * forbids naming a file in a docblock would forbid explaining the rule.
 */

import { describe, expect, test, afterAll } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { WorkerStateSchema, type WorkerState } from "../../src/contracts.ts";
import { runPaths, workerContainerName, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import type { Region } from "../../src/monitor/model.ts";
import {
  DOCKER_PS_TIMEOUT_MS,
  dockerPsArgv,
  parseDockerPs,
  readDockerContainers,
  type DockerPsRun,
} from "../../src/monitor/read/docker.ts";
import {
  EVENT_TAIL_BYTES,
  EVENT_TAIL_MAX_BYTES,
  readEventTail,
} from "../../src/monitor/read/events.ts";
import { readWorkerRow, readWorkerRows, type WorkerRead } from "../../src/monitor/read/worker.ts";
import { readRuns } from "../../src/monitor/read/runs.ts";

// ---------------------------------------------------------------------------
// Fixtures — every path from `runPaths`/`workerPaths`, including in this file.
// ---------------------------------------------------------------------------

const bases: string[] = [];
afterAll(async () => {
  for (const b of bases) await rm(b, { recursive: true, force: true }).catch(() => {});
});

const RUN_ID = "2026-09-02T00-00-00Z-mon0";

async function makeRoot(tag: string): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), `pifleet-monitor-${tag}-`));
  bases.push(base);
  return join(base, "runs");
}

/**
 * A run directory `runIdsAscending` will accept.
 *
 * `run.json` is not optional scaffolding: `paths.ts:937-957` stats it in every
 * entry and drops the ones without, so a fixture that omits it produces an
 * empty fleet and a test that passes for the wrong reason.
 */
async function makeRun(root: string, runId: string = RUN_ID): Promise<RunPaths> {
  const run = runPaths(runId, root);
  await mkdir(run.root, { recursive: true });
  await writeFile(run.runJson, JSON.stringify({ schema: "pifleet.run/v1", run_id: runId }));
  await mkdir(run.workersDir, { recursive: true });
  return run;
}

/**
 * A schema-VALID state file. Built through `WorkerStateSchema.parse` rather
 * than as a hand-written literal: a fixture the real reader would reject makes
 * every assertion below meaningless, and the schema is the only thing that can
 * say so.
 */
function stateFor(
  runId: string,
  worker: string,
  over: Partial<WorkerState> = {},
): WorkerState {
  return WorkerStateSchema.parse({
    schema: "pifleet.state/v1",
    worker,
    run_id: runId,
    // The test runner's own pid: alive by construction, so `liveRunIds`
    // resolves without a fleet. See the header.
    pid: process.pid,
    pgid: process.pid,
    started_at: new Date().toISOString(),
    phase: "idle",
    epoch: 0,
    ...over,
  });
}

async function writeWorker(
  run: RunPaths,
  worker: string,
  over: Partial<WorkerState> = {},
): Promise<void> {
  const paths = workerPaths(run, worker);
  await mkdir(paths.dir, { recursive: true });
  await writeFile(paths.stateJson, JSON.stringify(stateFor(run.runId, worker, over)));
}

/**
 * Truncate a worker's state file MID-TOKEN, which is ISC-475's exact fixture.
 *
 * Not "write garbage": a torn `writeJsonAtomic` produces a valid PREFIX of a
 * valid document, and that is the input `readValidated`'s retry
 * (`state.ts:815-830`) is written against. Cutting at 60% lands inside a
 * string or a number, so the retry re-reads, fails again, and the
 * `StateReadError` carries the byte count — which is what the row must show.
 */
async function truncateState(run: RunPaths, worker: string): Promise<string> {
  const path = workerPaths(run, worker).stateJson;
  const whole = await readFile(path, "utf8");
  await writeFile(path, whole.slice(0, Math.floor(whole.length * 0.6)));
  return path;
}

/**
 * A pid that is AFFIRMATIVELY gone, which is not the same as a large number.
 *
 * `safety/procstart.ts:142-152` holds the measurement, and it is a trap worth
 * writing down: `ps -o lstart= -p 999999999` exits 1 with *stderr* "process id
 * too large", and `processStartTime` treats any diagnostic on any channel as a
 * BROKEN READ and throws. Only a pid that once existed and was reaped is
 * silent on all three channels, which is the one case that returns `null` —
 * "gone". So a fixture that wants a dead worker has to reap a real process
 * rather than invent a pid above the ceiling; the invented one would make
 * `liveRunIds` throw and this test would pass for entirely the wrong reason.
 */
async function reapedPid(): Promise<number> {
  const proc = Bun.spawn(["true"], { stdout: "ignore", stderr: "ignore" });
  const pid = proc.pid;
  await proc.exited;
  return pid;
}

function expectOk<T>(region: Region<T>): T {
  if (region.status !== "ok") {
    throw new Error(`expected ok, got ${region.status}: ${JSON.stringify(region)}`);
  }
  return region.value;
}

function expectFailed<T>(region: Region<T>): string {
  if (region.status !== "failed") {
    throw new Error(`expected failed, got ${region.status}: ${JSON.stringify(region)}`);
  }
  return region.reason;
}

// ---------------------------------------------------------------------------
// Source-text probes (ISC-469, ISC-471, ISC-472)
// ---------------------------------------------------------------------------

const MODULE_DIR = join(fileURLToPath(new URL("../../src/monitor/read/", import.meta.url)));
/*
 * Views 2-4's readers join the four view 1 shipped with. They are added HERE
 * rather than given their own weaker check because ISC-471 and ISC-472 are
 * properties of the data plane, not of a particular view: `history.ts` walks
 * the runs root, `detail.ts` opens a worker directory, and `report.ts` resolves
 * a run — each of which is exactly the place a second path-deriver or a local
 * `JSON.parse` would arrive.
 */
const MODULES = [
  "runs.ts",
  "worker.ts",
  "events.ts",
  "docker.ts",
  "history.ts",
  "detail.ts",
  "report.ts",
] as const;

/**
 * Strip comments so the greps below judge CODE.
 *
 * Safe on these four files specifically, and the safety is a property of them
 * rather than of the regex: none contains a string literal holding `/*` or
 * `//` — no URLs, and the only escape in any literal is the tab in the Docker
 * format string. A general-purpose stripper would need a tokenizer; this one
 * is asserted against its own inputs by {@link "the stripper's assumption"}
 * below, so a future file that breaks the assumption fails loudly rather than
 * silently weakening every anti-criterion in this block.
 */
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^[ \t]*\/\/.*$/gm, "");
}

async function codeOf(file: string): Promise<string> {
  return stripComments(await readFile(join(MODULE_DIR, file), "utf8"));
}

describe("monitor data plane — source-text anti-criteria", () => {
  test("the stripper's assumption holds: no comment marker hides inside a string literal", async () => {
    for (const file of MODULES) {
      const raw = await readFile(join(MODULE_DIR, file), "utf8");
      // Every `//` and `/*` in these files must be a comment. If one ever
      // appears inside a quoted string the greps below go quietly blind, so
      // the assumption is checked rather than assumed.
      expect(raw).not.toMatch(/"[^"\n]*\/\/[^"\n]*"/);
      expect(raw).not.toMatch(/"[^"\n]*\/\*[^"\n]*"/);
    }
  });

  /**
   * ISC-471. `paths.ts:1-18`'s rule asserted rather than trusted.
   *
   * The filename list is the one §10 names plus the two siblings this data
   * plane also touches. A hit means the module has learned a second way to
   * resolve a run-directory path, which is ISC-188's recorded failure —
   * `config/render.ts` describing "four mounts at paths no run would ever
   * contain".
   */
  test("ISC-471: every run-directory path comes from runPaths/workerPaths", async () => {
    const forbidden = [
      "state.json",
      "events.jsonl",
      "attended.json",
      "presentation.json",
      "fence.json",
      "registry.json",
      "launch.json",
    ];
    for (const file of MODULES) {
      const code = await codeOf(file);
      // No path assembly against a run root.
      expect(code).not.toContain("join(");
      for (const name of forbidden) {
        expect(code).not.toContain(name);
      }
    }
  });

  /**
   * ISC-472. A local parser discards `readValidated`'s torn-read retry AND
   * `StateReadError`'s diagnosis, and `state.json` is rewritten every 250 ms
   * (`supervisor/index.ts:94`) while this plane reads it every 500 ms — so the
   * torn read is not hypothetical here, it is the likeliest place in the fleet
   * to meet one.
   */
  test("ISC-472: no module parses a control-plane document itself", async () => {
    for (const file of MODULES) {
      expect(await codeOf(file)).not.toContain("JSON.parse");
    }
  });

  /**
   * §2.6: "The name is the join key and it is derived, never spelled."
   *
   * This one is here because a MUTATION SURVIVED without it. Replacing
   * `workerContainerName(runId, id)` with the template literal
   * `` `pifleet-${runId}-${id}` `` produces a byte-identical string today, so
   * every behavioural assertion in this file stayed green. That is exactly the
   * failure `paths.ts:469-483` records — three of four call sites spelling
   * their own literal, "agreeing today, and one rename away from a `down` that
   * cleans up a container nobody launched". A monitor is the fifth caller, and
   * only a source-text probe can tell the difference before the rename.
   */
  test("the container name is derived by `workerContainerName`, never spelled", async () => {
    const code = await codeOf("worker.ts");
    expect(code).toContain("workerContainerName(");
    for (const file of MODULES) {
      expect(await codeOf(file)).not.toContain("pifleet-");
    }
  });

  /**
   * The read-only posture (D3/D15), asserted at the import list. `logs.ts` is
   * cited by the SRD as this plane's precedent and it is still refused as an
   * IMPORT: it lives under `src/cli/commands/`, and the walk is cheapest to
   * state when the monitor touches that directory nowhere at all.
   */
  test("no module imports a control plane, a dispatcher, or a container launcher", async () => {
    const forbidden = [
      "rpc/client.ts",
      "run/ledger.ts",
      "cli/commands/",
      "container/run.ts",
      "backends/cmux/",
    ];
    for (const file of MODULES) {
      const code = await codeOf(file);
      for (const mod of forbidden) expect(code).not.toContain(mod);
    }
  });
});

// ---------------------------------------------------------------------------
// ISC-469 — the Docker anti-criterion
// ---------------------------------------------------------------------------

describe("ISC-469: the monitor spawns exactly one distinct subprocess argv", () => {
  /**
   * Byte-for-byte against a literal, per D7. Written out element by element
   * rather than compared to a constant imported from the module, which would
   * assert only that the module equals itself.
   */
  test("the argv is exactly `docker ps --format '{{.Names}}\\t{{.Status}}'`", () => {
    expect(dockerPsArgv()).toEqual(["docker", "ps", "--format", "{{.Names}}\t{{.Status}}"]);
    // The tab is the field separator the parser splits on; a space here would
    // make every container name with a space in it unparseable, silently.
    expect(dockerPsArgv()[3]).toBe("{{.Names}}	{{.Status}}");
  });

  /**
   * **The load-bearing half.** A builder that takes a container name is one
   * refactor from taking a verb, and that refactor does not look like a
   * security change in a diff. An empty parameter list cannot be widened
   * invisibly.
   */
  test("the constructing function takes no parameters", () => {
    expect(dockerPsArgv.length).toBe(0);
  });

  test("the argv is frozen, so a caller cannot edit the next tick's command line", () => {
    const argv = dockerPsArgv();
    expect(Object.isFrozen(argv)).toBe(true);
    expect(() => {
      (argv as string[]).push("--all");
    }).toThrow();
    expect(dockerPsArgv()).toHaveLength(4);
  });

  /** D7's two refusals, asserted as absences because that is all they are. */
  test("no `docker inspect` and no `docker stats` anywhere in the module", async () => {
    const code = await codeOf("docker.ts");
    expect(code).not.toContain("inspect");
    expect(code).not.toContain("stats");
    // One `docker` verb, and it is `ps`.
    expect(code.match(/"docker"/g) ?? []).toHaveLength(1);
  });

  /**
   * The runner seam is nullary too. If a test double could be handed an argv,
   * the argv assertion above would guard the front door of a house with an
   * open back one.
   */
  test("the injectable runner takes no argv either", async () => {
    const calls: unknown[][] = [];
    const run: DockerPsRun = async (...args: unknown[]) => {
      calls.push(args);
      return { code: 0, stdout: "", stderr: "" };
    };
    await readDockerContainers({ run, now: () => 1 });
    expect(calls).toEqual([[]]);
  });

  test("the daemon timeout is bounded, so the slow clock cannot be wedged", () => {
    expect(DOCKER_PS_TIMEOUT_MS).toBeGreaterThan(0);
    expect(DOCKER_PS_TIMEOUT_MS).toBeLessThan(30_000);
  });
});

describe("the Docker plane, with no daemon (ISC-491)", () => {
  test("parses the pinned format and tolerates a line it does not understand", () => {
    const stdout = [
      `${workerContainerName(RUN_ID, "eng-1")}\tUp 9 hours`,
      `${workerContainerName(RUN_ID, "obs-1")}\tUp 27 hours`,
      "a line with no tab at all",
      "",
    ].join("\n");
    expect(parseDockerPs(stdout)).toEqual([
      { name: `pifleet-${RUN_ID}-eng-1`, status: "Up 9 hours" },
      { name: `pifleet-${RUN_ID}-obs-1`, status: "Up 27 hours" },
    ]);
  });

  /**
   * §6.7: "A failed `docker ps` is a region-level failure, not a crash."
   *
   * The assertion that matters is the SECOND one. `ok([])` would render
   * identically to a healthy daemon with nothing running, and would then mark
   * every live worker `container-gone` (`model.ts:114`) — a monitor
   * manufacturing the most actionable finding in the design out of a stopped
   * Docker Desktop.
   */
  test("a dead daemon is `failed`, never `ok` with an empty set", async () => {
    const run: DockerPsRun = async () => ({
      code: 1,
      stdout: "",
      stderr: "Cannot connect to the Docker daemon at unix:///var/run/docker.sock.\nIs the docker daemon running?",
    });
    const region = await readDockerContainers({ run, now: () => 7 });
    const reason = expectFailed(region);
    expect(reason).toContain("docker unavailable");
    expect(reason).toContain("Cannot connect to the Docker daemon");
    // The multi-line hint is clipped to its first line: a region reason is one
    // cell on a strip, not a stack trace.
    expect(reason).not.toContain("Is the docker daemon running?");
    expect(region.status === "failed" && region.readAt).toBe(7);
  });

  test("a runner that throws is still a region, not an exception", async () => {
    const run: DockerPsRun = async () => {
      throw new Error("spawn docker ENOENT");
    };
    expect(expectFailed(await readDockerContainers({ run, now: () => 1 }))).toContain("ENOENT");
  });

  test("`readAt` is stamped after the command finishes, never at dispatch", async () => {
    const clock = [100, 200, 300];
    let i = 0;
    const run: DockerPsRun = async () => ({ code: 0, stdout: "", stderr: "" });
    const region = await readDockerContainers({ run, now: () => clock[i++] ?? 999 });
    // Exactly one reading of the clock, taken after `run()` resolved.
    expect(region.status === "ok" && region.readAt).toBe(100);
    expect(i).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ISC-474 — a 24 MB event log rendered without being read whole
// ---------------------------------------------------------------------------

describe("ISC-474: a 24 MB events.jsonl is rendered without being read whole", () => {
  /**
   * The measured worst case (§2.4) is 24.7 MB across 8,336 lines in
   * `~/.pifleet/runs/2026-08-30T23-41-07Z-1b0a`. That path is NOT depended on:
   * a test that needs one host's runs directory is a test that grades `[~]`
   * everywhere else (ISC-491). The fixture reproduces the shape instead — the
   * same line count, ~3 KB per line, which §2.4 records as an `rpc` worker's
   * per-line cost.
   */
  const HUGE_LINES = 8_336;
  /** Built once. Three tests read it; writing 24 MB three times buys nothing. */
  let huge: Promise<{ run: RunPaths; bytes: number }> | null = null;
  function makeHugeLog(): Promise<{ run: RunPaths; bytes: number }> {
    huge ??= (async () => {
      const root = await makeRoot("events");
      const run = await makeRun(root);
      const paths = workerPaths(run, "eng-1");
      await mkdir(paths.dir, { recursive: true });

      const filler = "x".repeat(2_900);
      const lines: string[] = [];
      for (let seq = 0; seq < HUGE_LINES; seq++) {
        lines.push(JSON.stringify({ ts: "2026-08-30T23:41:07.000Z", type: "event", seq, filler }));
      }
      const body = `${lines.join("\n")}\n`;
      await writeFile(paths.eventsJsonl, body);
      // ASCII throughout, so code units are bytes — asserted rather than
      // assumed, because the byte count is the subject of this whole block.
      const bytes = new TextEncoder().encode(body).length;
      expect(bytes).toBe(body.length);
      return { run, bytes };
    })();
    return huge;
  }

  test("the bytes read are bounded by the tail window, not by the file", async () => {
    const { run, bytes } = await makeHugeLog();
    expect(bytes).toBeGreaterThan(24_000_000);

    const started = performance.now();
    const region = await readEventTail(workerPaths(run, "eng-1"));
    const elapsed = performance.now() - started;

    const tail = expectOk(region);
    // The criterion, stated as a number rather than as a claim.
    expect(tail.bytesRead).toBeLessThanOrEqual(EVENT_TAIL_BYTES);
    expect(tail.fileBytes).toBe(bytes);
    expect(tail.clippedHead).toBe(true);
    // The read is ~0.4% of the file. Asserting a ratio as well as a cap means
    // a future window that grew to "most of the file" fails here too.
    expect(tail.bytesRead / tail.fileBytes).toBeLessThan(0.01);

    // §10 also asks that the first frame paint inside the fast clock's period.
    // Only the READ is timed; the frame is the renderer's half.
    expect(elapsed).toBeLessThan(500);
  });

  /**
   * The head fragment is dropped, and this is what proves it: a window that
   * starts mid-file starts mid-record, and every returned line must be a whole
   * JSON object. Without the drop, line 0 is a suffix of one — the exact
   * corruption `util/jsonl.ts:57-67` records being "handed to the caller as if
   * it were valid".
   */
  test("every line handed back is a complete record, despite a mid-file start", async () => {
    const { run } = await makeHugeLog();
    const tail = expectOk(await readEventTail(workerPaths(run, "eng-1")));
    expect(tail.lines.length).toBeGreaterThan(5);
    for (const line of tail.lines) {
      expect(() => JSON.parse(line)).not.toThrow();
    }
    // The tail ends at EOF, so the last record present in the file is present
    // here — a tail that silently dropped the newest event would be useless.
    expect(JSON.parse(tail.lines[tail.lines.length - 1]!).seq).toBe(HUGE_LINES - 1);
  });

  /**
   * The bound is the property, so it must not be caller-defeatable. A future
   * `readEventTail(paths, { windowBytes: file.size })` would satisfy every
   * type in the module while performing the read the module exists to prevent.
   */
  test("a caller cannot raise the window past the hard cap", async () => {
    const { run } = await makeHugeLog();
    const tail = expectOk(
      await readEventTail(workerPaths(run, "eng-1"), { windowBytes: Number.MAX_SAFE_INTEGER }),
    );
    expect(tail.windowBytes).toBe(EVENT_TAIL_MAX_BYTES);
    expect(tail.bytesRead).toBeLessThanOrEqual(EVENT_TAIL_MAX_BYTES);
  });
});

describe("the event tail on ordinary files", () => {
  test("a log smaller than the window is returned whole, with no head clipped", async () => {
    const root = await makeRoot("events-small");
    const run = await makeRun(root);
    const paths = workerPaths(run, "eng-1");
    await mkdir(paths.dir, { recursive: true });
    await writeFile(
      paths.eventsJsonl,
      `${JSON.stringify({ type: "epoch_started" })}\n${JSON.stringify({ type: "settled" })}\n`,
    );

    const tail = expectOk(await readEventTail(paths));
    expect(tail.clippedHead).toBe(false);
    expect(tail.lines).toHaveLength(2);
    expect(tail.present).toBe(true);
  });

  /**
   * Absence is NORMAL — the supervisor creates the log lazily, which is why
   * `logs.ts:26-29`'s `--follow` waits for a file that is not there. So this
   * is `ok` with an empty value ("looked and found nothing"), not `never`
   * ("could not look"). `model.ts:57-64` requires the two to stay apart, and
   * `worker.ts` reaches the OPPOSITE answer for a missing state file because
   * `WorkerRow` has no empty inhabitant.
   */
  test("a log that does not exist yet is `ok` and empty, not `failed` and not `never`", async () => {
    const root = await makeRoot("events-absent");
    const run = await makeRun(root);
    const tail = expectOk(await readEventTail(workerPaths(run, "eng-1")));
    expect(tail.present).toBe(false);
    expect(tail.lines).toEqual([]);
    expect(tail.bytesRead).toBe(0);
  });

  test("a trailing partial line is withheld: on an append-only log it is an incomplete write", async () => {
    const root = await makeRoot("events-partial");
    const run = await makeRun(root);
    const paths = workerPaths(run, "eng-1");
    await mkdir(paths.dir, { recursive: true });
    await writeFile(paths.eventsJsonl, `${JSON.stringify({ type: "settled" })}\n{"type":"half`);

    const tail = expectOk(await readEventTail(paths));
    expect(tail.lines).toHaveLength(1);
    expect(tail.lines[0]).toContain("settled");
  });
});

// ---------------------------------------------------------------------------
// ISC-475 — one unreadable state file degrades one row
// ---------------------------------------------------------------------------

describe("ISC-475: an unreadable state.json degrades ONE row and no other", () => {
  test("the damaged row names the error; its siblings still render", async () => {
    const root = await makeRoot("degrade");
    const run = await makeRun(root);
    await writeWorker(run, "eng-1", { phase: "busy", task_id: "t-1" });
    await writeWorker(run, "eng-2", { phase: "idle" });
    await writeWorker(run, "eng-3", { phase: "stalled" });
    const damaged = await truncateState(run, "eng-2");

    const rows = await readWorkerRows(run, ["eng-1", "eng-2", "eng-3"]);
    expect(rows).toHaveLength(3);

    // The siblings are untouched — and untouched means their CONTENT survived,
    // not merely that they are `ok`. A degradation that blanked every phase
    // would pass a status-only assertion.
    const first = expectOk(rows[0]!);
    expect(first.row.phase).toBe("busy");
    expect(first.row.taskId).toBe("t-1");
    const third = expectOk(rows[2]!);
    expect(third.row.phase).toBe("stalled");

    // The damaged one carries `StateReadError`'s own diagnosis, which §6.4
    // requires on screen in place of the row rather than beside a stale value.
    const reason = expectFailed(rows[1]!);
    expect(reason).toContain("unreadable state file");
    expect(reason).toContain(damaged);
    expect(reason).toContain("bytes on disk");
  });

  /**
   * A worker directory with no state file at all is `never`, not `failed` and
   * not `ok`.
   *
   * `PartialWorkerRow` has no empty inhabitant: `phase` is a six-member enum
   * (`contracts.ts:68`) that `model.ts:130-134` requires "carried verbatim",
   * so there is no truthful row to return. Synthesising a seventh phase would
   * put a monitor-invented value in a field documented as the supervisor's own
   * word — ISC-216's shape.
   */
  test("a worker with no state file is `never`, distinct from a damaged one", async () => {
    const root = await makeRoot("never");
    const run = await makeRun(root);
    await mkdir(workerPaths(run, "eng-9").dir, { recursive: true });
    expect((await readWorkerRow(run, "eng-9")).status).toBe("never");
  });

  /**
   * A damaged SATELLITE must not take the row down. `phase`, `task_id` and the
   * transcript age all come from the state file and are still true; what is
   * lost is `activity` precision, and the honest report of that is a note —
   * the shape `CollectedReport.notes` (`report/collect.ts:68-115`) already
   * uses because "`report` is what an operator runs when things went WRONG".
   */
  test("a damaged presentation/attended file degrades a FIELD, not the row", async () => {
    const root = await makeRoot("satellite");
    const run = await makeRun(root);
    await writeWorker(run, "eng-1", { phase: "busy" });
    const paths = workerPaths(run, "eng-1");
    await writeFile(paths.presentationJson, '{"schema":"pifleet.presentation/v1","wor');
    await writeFile(paths.attendedJson, '{"schema":"pifleet.attended/v1","mo');

    const read = expectOk(await readWorkerRow(run, "eng-1"));
    expect(read.row.phase).toBe("busy");
    expect(read.evidence.notes).toHaveLength(2);
    expect(read.evidence.notes.join(" ")).toContain(paths.presentationJson);
    expect(read.evidence.notes.join(" ")).toContain(paths.attendedJson);
  });
});

// ---------------------------------------------------------------------------
// The worker row itself
// ---------------------------------------------------------------------------

describe("the worker row", () => {
  test("carries no `activity`: the ladder is derived in exactly one place", async () => {
    const root = await makeRoot("no-activity");
    const run = await makeRun(root);
    await writeWorker(run, "eng-1");
    const read = expectOk(await readWorkerRow(run, "eng-1"));
    // A MISSING field, not a placeholder value. A placeholder would be a sixth
    // activity state wearing one of the five names (`model.ts:99-104`).
    expect("activity" in read.row).toBe(false);
  });

  test("hands `activity.ts` the validated documents rather than making it re-read them", async () => {
    const root = await makeRoot("evidence");
    const run = await makeRun(root);
    await writeWorker(run, "eng-1", { session_present: true });
    const read = expectOk(await readWorkerRow(run, "eng-1"));
    expect(read.evidence.state.session_present).toBe(true);
    expect(read.evidence.presentation).toBeNull();
    expect(read.evidence.attended).toBeNull();
    expect(read.evidence.notes).toEqual([]);
  });

  /**
   * `containerPresent` has three values and the third is the point. `null` is
   * "the Docker region was not `ok`, so nothing was looked at"; `false` is
   * "`docker ps` ran and this container is gone", which `model.ts:114` turns
   * into the most actionable row in the design. Collapsing `null` to `false`
   * would manufacture that finding whenever the daemon is down.
   */
  test("joins the container by `workerContainerName`, and keeps `null` apart from `false`", async () => {
    const root = await makeRoot("containers");
    const run = await makeRun(root);
    await writeWorker(run, "eng-1");
    await writeWorker(run, "eng-2");

    const present = new Set([workerContainerName(run.runId, "eng-1")]);
    expect(expectOk(await readWorkerRow(run, "eng-1", { containers: present })).row.containerPresent)
      .toBe(true);
    expect(expectOk(await readWorkerRow(run, "eng-2", { containers: present })).row.containerPresent)
      .toBe(false);
    expect(expectOk(await readWorkerRow(run, "eng-1", { containers: null })).row.containerPresent)
      .toBeNull();
  });

  /**
   * The transcript age is READ from `transcript_activity`, never re-measured
   * by statting the session file — ISC-231/ISC-345's "two readers of one fact"
   * (D6's stated mitigation is written against exactly those).
   */
  test("transcript age comes from the supervisor's own reading, and `null` survives", async () => {
    const root = await makeRoot("transcript");
    const run = await makeRun(root);
    const grewAt = new Date(50_000).toISOString();
    await writeWorker(run, "eng-1", {
      transcript_activity: { entries: 12, last_growth_at: grewAt },
    });
    // Attended but never spoken: `last_growth_at` is null and the age must be
    // null too, not zero. Zero would read as "grew just now".
    await writeWorker(run, "eng-2", {
      transcript_activity: { entries: 0, last_growth_at: null },
    });
    // Not attended at all: the field itself is null (`contracts.ts:119-122`).
    await writeWorker(run, "eng-3");

    /*
     * `wallNow`, not `now`. The transcript stamp is written by the supervisor
     * in ISO epoch time, so its age is a WALL-CLOCK difference; `now` is the
     * monotonic clock behind `readAt` and has no shared origin with it
     * (`model.ts`'s two-clocks note). The two are set to different values here
     * on purpose: if the reader ever took the age from `now`, this reads 89_000
     * instead of 40_000 rather than passing by coincidence.
     */
    const now = () => 1_000;
    const wallNow = () => 90_000;
    expect(expectOk(await readWorkerRow(run, "eng-1", { now, wallNow })).row.transcriptAgeMs).toBe(
      40_000,
    );
    expect(
      expectOk(await readWorkerRow(run, "eng-2", { now, wallNow })).row.transcriptAgeMs,
    ).toBeNull();
    expect(
      expectOk(await readWorkerRow(run, "eng-3", { now, wallNow })).row.transcriptAgeMs,
    ).toBeNull();
  });

  test("a future stamp clamps to zero rather than rendering a transcript that grew ahead of the clock", async () => {
    const root = await makeRoot("skew");
    const run = await makeRun(root);
    await writeWorker(run, "eng-1", {
      transcript_activity: { entries: 1, last_growth_at: new Date(90_000).toISOString() },
    });
    expect(
      expectOk(await readWorkerRow(run, "eng-1", { now: () => 7, wallNow: () => 50_000 })).row
        .transcriptAgeMs,
    ).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// The run walk
// ---------------------------------------------------------------------------

describe("readRuns", () => {
  test("returns the live run with its workers in a stable order", async () => {
    const root = await makeRoot("runs");
    const run = await makeRun(root);
    await writeWorker(run, "eng-2", { phase: "idle" });
    await writeWorker(run, "eng-1", { phase: "busy" });
    // A finished run: on disk, with no live worker. D8 says it must not appear.
    const dead = await makeRun(root, "2026-08-01T00-00-00Z-old0");
    const gone = await reapedPid();
    await writeWorker(dead, "eng-1", { pid: gone, pgid: gone });

    const runs = expectOk(await readRuns({ root, containers: null }));
    expect(runs.map((r) => r.runId)).toEqual([RUN_ID]);
    const workers = runs[0]!.workers.map((w) => expectOk(w).row.workerId);
    // Sorted, not `readdir` order: an unsorted table reshuffles between ticks
    // with no state change behind it, which looks exactly like activity.
    expect(workers).toEqual(["eng-1", "eng-2"]);
  });

  test("an empty runs root is `ok` and empty — looked, and found nothing", async () => {
    const root = await makeRoot("empty");
    await mkdir(root, { recursive: true });
    expect(expectOk(await readRuns({ root }))).toEqual([]);
  });

  test("`readAt` is stamped after the walk, not before it", async () => {
    const root = await makeRoot("readat");
    const run = await makeRun(root);
    await writeWorker(run, "eng-1");
    const ticks = [1_000, 2_000, 3_000, 4_000, 5_000];
    let i = 0;
    const region = await readRuns({ root, now: () => ticks[i++] ?? 9_999 });
    // The row clock and the region clock both advance; the region's stamp is
    // the LAST reading, which is what makes the age honest on a 403 ms walk.
    expect(region.status === "ok" && region.readAt).toBe(ticks[i - 1]!);
    expect(i).toBeGreaterThan(1);
  });

  /**
   * **The blast radius this data plane cannot contain, pinned as a test rather
   * than described in a docblock.**
   *
   * `registry.ts:1043-1046` calls `readWorkerState` with no `try`, so a
   * damaged state file throws out of `liveRunIds` itself — before any row
   * exists to degrade. ISC-475 therefore holds for the worker TABLE (asserted
   * above) and NOT across the enumeration step.
   *
   * The fixture has exactly ONE worker so the outcome is deterministic:
   * `liveRunIds` cannot break out early on a live sibling, so it must reach
   * the damaged file. With more than one worker the result would depend on
   * `readdir` order, which is filesystem-dependent — a flaky test dressed as a
   * criterion.
   *
   * What is asserted is the honest behaviour available from here: the monitor
   * DEGRADES rather than crashing, and says which file it choked on. Closing
   * the gap properly means giving `registry.ts`'s worker loop the same
   * per-worker tolerance `readWorkerRow` has, which is a change to the module
   * the whole fleet's liveness depends on and is out of this plane's scope.
   */
  test("a damaged worker no longer takes out the enumeration (ISC-494)", async () => {
    // The fixture this replaces asserted the DEFECT: `registry.ts` called
    // `readWorkerState` with no `try`, so one unparseable state file threw out
    // of `liveRunIds` before any row existed to degrade, and the honest thing
    // available from here was to report a failed region. **That gap is now
    // closed** — both `liveRunIds` and `latestLiveRunId` carry a per-worker
    // catch (ISC-494, pinned in `status-live-run.test.ts`) — so the enumeration
    // completes and this must assert the new truth rather than the old one.
    const root = await makeRoot("enumeration-live-sibling");
    const run = await makeRun(root);
    await writeWorker(run, "eng-1");
    await writeWorker(run, "eng-2");
    const damaged = await truncateState(run, "eng-1");

    // THE CRITERION (ISC-475): the region succeeds, the run is present, and the
    // damage is confined to the one worker that carries it.
    const rows = expectOk(await readRuns({ root }));
    expect(rows).toHaveLength(1);
    const workers = rows[0]!.workers;
    expect(workers).toHaveLength(2);

    const broken = workers.filter((w) => w.status === "failed");
    expect(broken, "the damaged worker must not be silently dropped").toHaveLength(1);
    expect(JSON.stringify(broken[0])).toContain(damaged);
    // …and the sibling is untouched, which is the half that makes this a
    // degradation rather than a failure.
    expect(workers.filter((w) => w.status === "ok")).toHaveLength(1);
  });

  /**
   * THE RESIDUAL, asserted rather than left as a comment, because it is the
   * one case ISC-475 does NOT cover and a future reader will otherwise treat
   * the criterion as broader than it is.
   *
   * A run whose ONLY worker has an unreadable `state.json` cannot be judged
   * live by `registry.ts` — liveness is derived from a worker state, and there
   * is no readable one. So the run drops out of `liveRunIds` and the monitor
   * never sees it. **This is not fixable at the display layer**: telling a
   * finished run from a damaged one requires reading every run under the root,
   * which is the O(all runs) cost D4 deliberately keeps off every clock, and
   * deciding liveness here would make the monitor a second reader of a fact
   * `registry.ts` owns — the exact shape ISC-231 and ISC-345 record.
   *
   * It is a strictly smaller failure than the one it replaced: before, that
   * same file broke the enumeration for EVERY run.
   */
  test("a run whose only worker is unreadable drops out, and that is the known residual", async () => {
    const root = await makeRoot("enumeration-sole-worker");
    const run = await makeRun(root);
    await writeWorker(run, "eng-1");
    await truncateState(run, "eng-1");

    // `ok`, not `failed`: the enumeration completed. The run is absent because
    // nothing could establish it was live, not because anything threw.
    expect(expectOk(await readRuns({ root }))).toEqual([]);
  });

  test("a runs root that does not exist is `ok` and empty, never a throw", async () => {
    const root = join(await makeRoot("missing"), "nope");
    expect(expectOk(await readRuns({ root }))).toEqual([]);
  });
});
