/**
 * `pifleet triage`'s own decisions, driven in-process (SRD-TRIAGE-CONSOLE §13
 * task 6.2, §12's console-and-actor block).
 *
 * ## Why this file exists at all
 *
 * §13's acceptance names it: *"the command is imported in-process by its own
 * test"*, and §12 says why in the repository's own terms — *"This is the coverage
 * gate's own recorded pattern: `test/unit/pm-guard-command.test.ts` exists because
 * the wiring layer fell out of the report once already."* §3.3 states the rule
 * behind both: **the command-wiring layer is the layer the coverage gate keeps
 * catching**, because a module nothing imports is a module whose refusals nobody
 * has ever executed.
 *
 * Importing a module to raise a number would be worthless, so this file is not
 * that. It asserts the four things no pure-function test of `triagePass` can:
 *
 *   - **The `--once`/loop asymmetry.** §6.4 makes the catch a decision rather
 *     than an omission — the loop *"catches a thrown pass and continues"* and
 *     *"`--once` deliberately does not get the catch, because a single pass is
 *     somebody's command and its exit code should mean something"*. That is one
 *     `try` that must exist and one that must not, in the same file, and the
 *     second is a NEGATIVE — exactly what a later "hardening" edit adds without
 *     noticing. Both halves are driven through the real command with one throwing
 *     pass, in one test.
 *   - **`--status`'s three distinct fields.** §12: *"assert sweeps completed,
 *     incidents by state, and the undelivered count are three distinct fields. A
 *     single 'OK' line is how 'quiet' and 'could not speak' become one row."*
 *     `Object.keys` is asserted by full sorted value, ISC-709's own instrument, so
 *     a field cannot be added or removed silently.
 *   - **The incident census**, which had no producer before task 6.2 and is the
 *     only thing that can answer *"incidents by state"* at all.
 *   - **The run-tree half of §6.4's driver** — including the zero-row case §6.4's
 *     own sentence gets wrong.
 *
 * ## No test here starts a clock, reaches a network, or touches `~/.pifleet`
 *
 * §12's closing anti-criterion: *"no criterion in this block requires a real
 * terminal, a real model, a real cluster, or the network."* Every transport is
 * injected. The census tests reach no filesystem at all — `CensusDeps` is backed
 * by a `Map` — and the run-tree tests use `mkdtemp` with `PIFLEET_RUNS_DIR` and
 * `HOME` both redirected, so `incidentRecordRoot`, which is keyed off the runs
 * root's parent, cannot resolve to the operator's own.
 *
 * The loop is driven ONCE, with an injected `sleep` that aborts the signal before
 * it resolves — `runTriageActor` checks `isStopped` immediately after `sleep`
 * (`triage-actor.ts:604-608`), so the loop provably terminates after one pass with
 * no timer running. §13 task 6.1's *"no test starts the loop"* forbids a test that
 * WAITS on one; a test that measures its own timeout is the failure it names.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildProgram, CliError } from "../../src/cli/index.ts";
import { EXIT } from "../../src/contracts.ts";
import {
  CONSOLE_HEALTH_KINDS,
  CONSOLE_SCOPE,
  INCIDENT_STATES,
  freshIncidentRecord,
  incidentRecordPath,
  saveIncidentRecord,
  type IncidentRecord,
  type IncidentSubject,
} from "../../src/run/triage-incident.ts";
import { freshDeliveryState, reporterStatus } from "../../src/run/triage-notify.ts";
import { runTriageActor, TRIAGE_COLLATOR } from "../../src/run/triage-actor.ts";
import { runPaths } from "../../src/run/paths.ts";
import type { TriagePassOutcome } from "../../src/run/triage-pass.ts";
import {
  DEFAULT_CENSUS_DEPS,
  SWEEP_NOT_WIRED,
  buildSweepDriver,
  highestSweepNumber,
  incidentCensus,
  inFlightSweep,
  productionTriageDeps,
  register,
  renderStatus,
  resolveSeatRuns,
  triageStatus,
  type CensusDeps,
  type TriageCommandDeps,
  type TriageStatus,
} from "../../src/cli/commands/triage.ts";

// ---------------------------------------------------------------------------
// Isolation
// ---------------------------------------------------------------------------

/**
 * `PIFLEET_RUNS_DIR` and `HOME` as they were BEFORE this file touched them,
 * captured at module load on `pm-guard-command.test.ts`'s reasoning: `beforeEach`
 * overwrites them, `afterAll` deletes the directory they point at, and bun's file
 * order is `readdir()` order — so leaving either dangling hands a deleted path to
 * whichever file happens to run next.
 *
 * **`HOME` matters as much as `PIFLEET_RUNS_DIR` here**, because
 * `incidentRecordRoot` is `dirname(runsRoot(env))/triage` and `runsRoot` falls
 * back to `$HOME/.pifleet/runs`. A fixture that set only one of the two would
 * write incident records into the operator's real `~/.pifleet/triage`.
 */
const RUNS_DIR_BEFORE = process.env["PIFLEET_RUNS_DIR"];
const HOME_BEFORE = process.env["HOME"];
const bases: string[] = [];

afterAll(async () => {
  for (const base of bases) await rm(base, { recursive: true, force: true });
  if (RUNS_DIR_BEFORE === undefined) delete process.env["PIFLEET_RUNS_DIR"];
  else process.env["PIFLEET_RUNS_DIR"] = RUNS_DIR_BEFORE;
  if (HOME_BEFORE === undefined) delete process.env["HOME"];
  else process.env["HOME"] = HOME_BEFORE;
});

async function tempBase(): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), "pifleet-triage-cmd-"));
  bases.push(base);
  return base;
}

beforeEach(async () => {
  const base = await tempBase();
  process.env["HOME"] = base;
  process.env["PIFLEET_RUNS_DIR"] = join(base, ".pifleet", "runs");
});

/**
 * An env that resolves nowhere real, for the tests that reach no disk.
 *
 * `incidentRecordRoot` takes `dirname` of the runs root, so this puts the record
 * root at `/nonexistent-pifleet-fixture/triage` — a path the census only ever
 * hands to an injected `CensusDeps`, never to `readdir`.
 */
const FAKE_ENV: Record<string, string | undefined> = {
  PIFLEET_RUNS_DIR: "/nonexistent-pifleet-fixture/runs",
  HOME: "/nonexistent-pifleet-fixture",
};

// ---------------------------------------------------------------------------
// A census backed by a Map rather than by a filesystem
// ---------------------------------------------------------------------------

/** Bytes keyed by absolute path, listed the way `readdir` would list them. */
function censusOver(files: ReadonlyMap<string, string>): CensusDeps {
  return {
    list: async (dir) => {
      const prefix = `${dir}/`;
      const names = new Set<string>();
      for (const path of files.keys()) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const cut = rest.indexOf("/");
        names.add(cut === -1 ? rest : rest.slice(0, cut));
      }
      return names.size === 0 ? null : [...names];
    },
    read: async (path) => files.get(path) ?? null,
  };
}

/** A valid §7.6 record, produced by the PRODUCTION writer so it must parse back. */
async function recordBytes(
  subject: IncidentSubject,
  patch: Partial<IncidentRecord> = {},
): Promise<string> {
  let written = "";
  await saveIncidentRecord({
    record: { ...freshIncidentRecord(subject), ...patch },
    env: FAKE_ENV,
    deps: {
      writeText: async (_path, text) => {
        written = text;
      },
    },
  });
  return written;
}

async function fixtureFiles(
  entries: readonly (readonly [IncidentSubject, Partial<IncidentRecord>])[],
): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for (const [subject, patch] of entries) {
    files.set(incidentRecordPath(subject, FAKE_ENV), await recordBytes(subject, patch));
  }
  return files;
}

// ---------------------------------------------------------------------------
// The wiring, imported in-process (§13 acceptance, §3.3)
// ---------------------------------------------------------------------------

/**
 * Drive `pifleet triage <args>` through a real commander program and return what
 * it threw, what it printed, and what it wrote to stderr.
 *
 * A FRESH program per call, because commander accumulates parsed option state on
 * the command object — a shared program would let one case's `--once` satisfy the
 * next case's default branch.
 */
async function runTriage(
  args: readonly string[],
  deps: TriageCommandDeps,
): Promise<{ err: unknown; out: string; errOut: string }> {
  const program = new Command();
  program.exitOverride();
  register(program, () => deps);

  const out: string[] = [];
  const errOut: string[] = [];
  const stdout = process.stdout.write.bind(process.stdout);
  const stderr = process.stderr.write.bind(process.stderr);
  const capture = (sink: string[]) =>
    ((chunk: string | Uint8Array) => {
      sink.push(typeof chunk === "string" ? chunk : new TextDecoder().decode(chunk));
      return true;
    }) as typeof process.stdout.write;
  process.stdout.write = capture(out);
  process.stderr.write = capture(errOut);
  try {
    await program.parseAsync(["triage", ...args], { from: "user" });
    return { err: null, out: out.join(""), errOut: errOut.join("") };
  } catch (err) {
    return { err, out: out.join(""), errOut: errOut.join("") };
  } finally {
    process.stdout.write = stdout;
    process.stderr.write = stderr;
  }
}

/**
 * The `DeliveryState` a pass that lost nothing carries. `freshDeliveryState` is
 * the production factory, so this fixture cannot drift from the shape the
 * notifier actually produces.
 */
const CLEAN_DELIVERY = freshDeliveryState();

const NOTHING_OUTCOME: TriagePassOutcome = {
  kind: "swept",
  cursor: { runs: {}, sweep_cursor: 1, consecutive_skips: 0 },
  delivery: CLEAN_DELIVERY,
  saturationMemo: { result: null, sweepId: null },
  sweepId: "T-sweep-1",
  waitingOn: null,
  assessment: null,
  saturation: null,
  partition: null,
  dispatched: [],
  notifications: [],
  report: {
    state: CLEAN_DELIVERY,
    deliveries: [],
    reporterUndelivered: false,
    log: [],
    status: reporterStatus(CLEAN_DELIVERY, null),
    lost: [],
  },
  written: [],
  refused: [],
};

const EMPTY_STATUS: TriageStatus = {
  schema: "pifleet.triagestatus/v1",
  actor: "absent",
  actor_reason: null,
  pid: null,
  cadence_s: null,
  sweeps_completed: null,
  consecutive_skips: null,
  incidents: { clear: 0, provisional: 0, firing: 0, flapping: 0 },
  undelivered: 0,
  refused: [],
  log_path: "/fixture/triage-relay.log",
};

function stubDeps(over: Partial<TriageCommandDeps> = {}): TriageCommandDeps {
  return {
    pass: async () => NOTHING_OUTCOME,
    loop: async () => ({ kind: "stopped", passes: 0 }),
    status: async () => EMPTY_STATUS,
    ...over,
  };
}

describe("pifleet triage — the wiring layer (§13 task 6.2, §3.3)", () => {
  test("register puts `triage` on a real buildProgram()", () => {
    const program = buildProgram();
    register(program, () => stubDeps());
    expect(program.commands.map((c) => c.name())).toContain("triage");
  });

  /**
   * §13 names four flags. Asserted BY NAME against the full sorted set rather
   * than by `toContain` each, on `monitor-readonly.test.ts`'s rule: naming the
   * permitted set is what makes a fifth member fail, and a flag silently dropped
   * in a refactor is exactly the regression `--help` will not report.
   */
  test("carries exactly the four flags §13 names", () => {
    const program = buildProgram();
    register(program, () => stubDeps());
    const cmd = program.commands.find((c) => c.name() === "triage")!;
    expect(cmd.options.map((o) => o.long).sort()).toEqual([
      "--json",
      "--once",
      "--poll",
      "--status",
    ]);
  });

  test("--poll refuses a value that is not a positive number of seconds", async () => {
    for (const bad of ["0", "-5", "soon"]) {
      const { err } = await runTriage(["--poll", bad], stubDeps());
      expect(err).toBeInstanceOf(CliError);
      expect((err as CliError).exitCode).toBe(EXIT.USAGE);
    }
  });
});

// ---------------------------------------------------------------------------
// §6.4's asymmetry — the whole of §12's "a thrown pass" criterion that is HERE
// ---------------------------------------------------------------------------

describe("§6.4: the loop catches a thrown pass and --once does not", () => {
  /**
   * ONE test, both halves, one throwing pass — because the halves are only
   * meaningful against each other. A test that asserted the loop continues would
   * pass against an implementation that wrapped `--once` too, and a test that
   * asserted `--once` propagates would pass against one that had no loop at all.
   *
   * The loop half drives the REAL `runTriageActor`, wired exactly as
   * `productionTriageDeps` wires it, so this is the shipped path rather than a
   * re-implementation of it. Its `sleep` aborts the signal before resolving, and
   * `triage-actor.ts:604-608` checks `isStopped` immediately after `sleep`, so
   * the loop terminates after one pass with no timer.
   */
  test("--once propagates the throw; the same pass in the loop does not end it", async () => {
    const boom = new Error("the sweep exploded");
    let onceCalls = 0;
    const once = await runTriage(
      ["--once"],
      stubDeps({
        pass: async () => {
          onceCalls += 1;
          throw boom;
        },
      }),
    );
    expect(once.err).toBe(boom);
    // Exactly one, so a retry loop cannot hide behind a propagated throw.
    expect(onceCalls).toBe(1);

    let loopCalls = 0;
    const controller = new AbortController();
    const logged: string[] = [];
    const loop = await runTriage(
      ["--poll", "300"],
      stubDeps({
        pass: async () => {
          loopCalls += 1;
          throw boom;
        },
        loop: async (pass, opts) =>
          await runTriageActor(
            {
              pass: async () => (await pass()).cursor,
              isCollatorLive: async () => true,
              saveCursor: async () => {},
              log: async (e) => {
                logged.push(e.kind);
              },
              sleep: async () => {
                controller.abort();
              },
            },
            { cadenceS: opts.cadenceS, runId: "r", signal: controller.signal },
          ),
      }),
    );
    // The throw did NOT escape the loop, and the loop said so on §7.7's log
    // rather than on the fleet ledger (§12's 2026-09-06 RULING).
    expect(loop.err).toBeNull();
    expect(loopCalls).toBe(1);
    expect(logged).toContain("pass_failed");
    expect(logged).toContain("actor_stopped");
  });

  test("--once runs exactly one pass and never reaches the loop", async () => {
    let passes = 0;
    let loops = 0;
    const { err } = await runTriage(
      ["--once"],
      stubDeps({
        pass: async () => {
          passes += 1;
          return NOTHING_OUTCOME;
        },
        loop: async () => {
          loops += 1;
          return { kind: "stopped", passes: 0 };
        },
      }),
    );
    expect(err).toBeNull();
    expect(passes).toBe(1);
    expect(loops).toBe(0);
  });

  /**
   * The production deps REFUSE a sweep rather than reporting a success they did
   * not have. `relay.ts`'s recorded posture: *"a stub that dispatched nothing and
   * returned success would be indistinguishable from a working relay"*.
   */
  test("the production pass refuses by name until §7.2's renderer exists", async () => {
    const { err } = await runTriage(["--once"], productionTriageDeps());
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe(SWEEP_NOT_WIRED);
    expect(SWEEP_NOT_WIRED).toContain("§7.2");
  });

  /**
   * **`--poll` refuses UP FRONT and does not enter a loop around a pass that
   * cannot work**, which is §6.4's supervision argument turned on this half-built
   * state. The loop catches a thrown pass and continues *by design*, so a
   * production `--poll` wired to a refusing pass would log the same refusal every
   * five minutes for days while the actor record said an actor was armed — *"a
   * console that dispatched nothing is indistinguishable from one with nothing to
   * dispatch"*, manufactured by the resilience mechanism rather than prevented by
   * it.
   *
   * Asserted with a wall clock rather than only on the error, because "refused
   * immediately" and "refused after one 300-second cadence" are the same value
   * and different behaviours, and it is the second one that would hang a suite.
   */
  test("the production loop refuses up front rather than spinning on a refusing pass", async () => {
    const started = Date.now();
    const { err } = await runTriage(["--poll", "300"], productionTriageDeps());
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe(SWEEP_NOT_WIRED);
    expect(Date.now() - started).toBeLessThan(1_000);
  });
});

// ---------------------------------------------------------------------------
// §12: --status cannot be read as an all-clear
// ---------------------------------------------------------------------------

describe("§12 / §6.9 requirement 7: --status reports three distinct fields", () => {
  /**
   * ISC-709's instrument, applied to the value that carries all three fields
   * rather than only to the channel: `Object.keys` by full sorted value, so a
   * field cannot be added or removed silently — and in particular so no future
   * edit can add the aggregate the criterion forbids.
   */
  test("the field set is fixed by name and holds no aggregate", async () => {
    /**
     * The keys of a value `triageStatus` PRODUCED, never of a literal declared
     * here — ISC-709's instrument taken exactly, and the distinction is the
     * whole strength of the assertion. A hand-written fixture's keys are the
     * fixture author's opinion: a field added to the interface AND to the
     * producer leaves such a fixture untouched, so the test stays green while
     * the shipped `--status` grows the aggregate §6.9 requirement 7 forbids.
     * Measured — that mutant SURVIVED the literal-based version of this test.
     */
    const produced = await triageStatus(FAKE_ENV, censusOver(new Map()), async () => ({
      kind: "absent",
    }));
    expect(Object.keys(produced).sort()).toEqual([
      "actor",
      "actor_reason",
      "cadence_s",
      "consecutive_skips",
      "incidents",
      "log_path",
      "pid",
      "refused",
      "schema",
      "sweeps_completed",
      "undelivered",
    ]);
    // The `present` arm is a SECOND object literal in the source and can grow a
    // field the `absent` arm does not, so both are pinned to the same set.
    const present = await triageStatus(FAKE_ENV, censusOver(new Map()), async () => ({
      kind: "ok",
      record: {
        schema: "pifleet.consolerelay/v1",
        pid: 1,
        started: "t",
        console: "triage",
        run_id: "r",
        pinned: null,
        workers: [],
        started_at: "2026-09-06T00:00:00Z",
        log_path: "/fixture/log",
        runs: {},
        cadence_s: 300,
        sweep_cursor: 0,
        consecutive_skips: 0,
      },
    }));
    expect(Object.keys(present).sort()).toEqual(Object.keys(produced).sort());
    for (const banned of ["ok", "healthy", "status", "all_clear", "summary"]) {
      expect(Object.keys(produced)).not.toContain(banned);
      expect(Object.keys(present)).not.toContain(banned);
    }

    // And the fixture the command-level tests drive must agree with what the
    // producer makes, or those tests would be exercising a shape that never
    // ships. Compared against `produced` rather than against a third copy of the
    // list, so there is exactly one place the field set is written down.
    expect(Object.keys(EMPTY_STATUS).sort()).toEqual(Object.keys(produced).sort());
    // The three §12 names, present and mutually distinct.
    for (const field of ["sweeps_completed", "incidents", "undelivered"]) {
      expect(Object.keys(produced)).toContain(field);
    }
  });

  test("no rendered line merges two of the three numbers, and none says ok", () => {
    const rendered = renderStatus({
      ...EMPTY_STATUS,
      actor: "present",
      pid: 42,
      sweeps_completed: 9,
      consecutive_skips: 0,
      incidents: { clear: 1, provisional: 0, firing: 2, flapping: 0 },
      undelivered: 3,
    });
    const lines = rendered.split("\n");
    expect(lines.some((l) => l.startsWith("sweeps completed: 9"))).toBe(true);
    expect(lines.some((l) => l.startsWith("incidents by state: ") && l.includes("firing=2"))).toBe(
      true,
    );
    expect(lines.some((l) => l.startsWith("undelivered notifications: 3"))).toBe(true);
    // Three numbers, three lines: no line carries more than one of them.
    const carriers = lines.filter(
      (l) => l.includes("sweeps completed") || l.includes("undelivered notifications"),
    );
    expect(carriers).toHaveLength(2);
    expect(rendered.toLowerCase()).not.toContain("all clear");
  });

  /**
   * **An absent actor record is not zero sweeps.** A console that has never
   * started and one that started and has not yet swept are different conditions,
   * and a `0` default makes the first wear the second's costume — the
   * absence-as-evidence mistake this console exists to refuse.
   */
  test("an absent actor record reports sweeps as null, never as 0", async () => {
    const status = await triageStatus(FAKE_ENV, censusOver(new Map()), async () => ({
      kind: "absent",
    }));
    expect(status.actor).toBe("absent");
    expect(status.sweeps_completed).toBeNull();
    expect(status.sweeps_completed).not.toBe(0);
    expect(renderStatus(status)).toContain("sweeps completed: unknown");
  });

  test("a refused actor record is its own state and carries its reason", async () => {
    const status = await triageStatus(FAKE_ENV, censusOver(new Map()), async () => ({
      kind: "refused",
      reason: "truncated mid-write",
    }));
    expect(status.actor).toBe("refused");
    expect(status.actor_reason).toBe("truncated mid-write");
    expect(status.sweeps_completed).toBeNull();
  });

  test("sweeps completed comes from §7.7's cursor when the record is there", async () => {
    const status = await triageStatus(FAKE_ENV, censusOver(new Map()), async () => ({
      kind: "ok",
      record: {
        schema: "pifleet.consolerelay/v1",
        pid: 4242,
        started: "tok",
        console: "triage",
        run_id: "r1",
        pinned: null,
        workers: [TRIAGE_COLLATOR],
        started_at: "2026-09-06T00:00:00Z",
        log_path: "/fixture/log",
        runs: { [TRIAGE_COLLATOR]: "r1" },
        cadence_s: 300,
        sweep_cursor: 17,
        consecutive_skips: 2,
      },
    }));
    expect(status.sweeps_completed).toBe(17);
    expect(status.consecutive_skips).toBe(2);
    expect(status.pid).toBe(4242);
  });

  test("--status --json prints the value and never starts a pass", async () => {
    let passes = 0;
    const { err, out } = await runTriage(
      ["--status", "--json"],
      stubDeps({
        pass: async () => {
          passes += 1;
          return NOTHING_OUTCOME;
        },
      }),
    );
    expect(err).toBeNull();
    expect(passes).toBe(0);
    expect(JSON.parse(out) as TriageStatus).toEqual(EMPTY_STATUS);
  });
});

// ---------------------------------------------------------------------------
// The census — §12's second field, which had no producer
// ---------------------------------------------------------------------------

describe("the incident census (§12's 'incidents by state')", () => {
  test("an absent record root is an empty table, not an error", async () => {
    const census = await incidentCensus(FAKE_ENV, censusOver(new Map()));
    expect(census.records).toBe(0);
    expect(census.refused).toEqual([]);
    // Every state named, so a caller doing `?? 0` cannot confuse "zero" with
    // "the key was never emitted".
    expect(Object.keys(census.by_state).sort()).toEqual([...INCIDENT_STATES].sort());
  });

  test("counts both record layouts by state and sums undelivered separately", async () => {
    const files = await fixtureFiles([
      [{ kind: "service", environment: "cni-dev", service: "alpha" }, { state: "firing" }],
      [
        { kind: "service", environment: "cni-dev", service: "beta" },
        { state: "firing", undelivered: ["lost one", "lost two"] },
      ],
      [{ kind: "service", environment: "cni-dev", service: "gamma" }, { state: "clear" }],
      [
        { kind: "console_health", scope: CONSOLE_SCOPE, health: "sweeps_skipped" },
        { state: "flapping", undelivered: ["lost three"] },
      ],
    ]);
    const census = await incidentCensus(FAKE_ENV, censusOver(files));
    expect(census.by_state).toEqual({ clear: 1, provisional: 0, firing: 2, flapping: 1 });
    expect(census.records).toBe(4);
    // The undelivered count is its OWN number and is not any state's count.
    expect(census.undelivered).toBe(3);
    expect(census.refused).toEqual([]);
  });

  /**
   * **An unreadable record is not a clear one**, and the direction matters: a
   * truncated write folded into `clear` presents as good news, which is the
   * absence-as-evidence failure the whole console is against.
   */
  test("a record the schema refuses is counted in NO state", async () => {
    const subject: IncidentSubject = {
      kind: "service",
      environment: "cni-dev",
      service: "alpha",
    };
    const files = new Map<string, string>([
      [incidentRecordPath(subject, FAKE_ENV), '{"subject":{"kind":"service"'],
    ]);
    const census = await incidentCensus(FAKE_ENV, censusOver(files));
    expect(census.records).toBe(0);
    expect(census.by_state).toEqual({ clear: 0, provisional: 0, firing: 0, flapping: 0 });
    expect(census.refused).toHaveLength(1);
    expect(census.refused[0]!.reason).toContain("is not JSON");
  });

  test("a file that is no record layout at all is refused, never descended into", async () => {
    const root = "/nonexistent-pifleet-fixture/triage";
    const files = new Map<string, string>([[join(root, "cni-dev", "notes.txt"), "hello"]]);
    const census = await incidentCensus(FAKE_ENV, censusOver(files));
    expect(census.records).toBe(0);
    expect(census.refused).toHaveLength(1);
    expect(census.refused[0]!.path).toContain("notes.txt");
  });

  /**
   * The console-health names come from the EXPORTED tuple, so a member added
   * after this line was written is read rather than rejected. The set grew from
   * six to seven on 2026-09-06 (`inference_unreachable`, task 5.4d) and §6.8a's
   * table is the kind of thing that grows again; a hand-written copy here would
   * start reporting a live incident kind as an unrecognised file.
   */
  test("every CONSOLE_HEALTH_KINDS member is a countable record, whatever the set holds", async () => {
    const files = await fixtureFiles(
      CONSOLE_HEALTH_KINDS.map(
        (health) =>
          [{ kind: "console_health", scope: CONSOLE_SCOPE, health }, { state: "firing" }] as const,
      ),
    );
    const census = await incidentCensus(FAKE_ENV, censusOver(files));
    expect(census.records).toBe(CONSOLE_HEALTH_KINDS.length);
    expect(census.by_state.firing).toBe(CONSOLE_HEALTH_KINDS.length);
    expect(census.refused).toEqual([]);
  });

  test("a health name outside the enum is refused rather than counted", async () => {
    const root = "/nonexistent-pifleet-fixture/triage";
    const files = new Map<string, string>([
      [join(root, CONSOLE_SCOPE, CONSOLE_SCOPE, "not_a_kind.json"), "{}"],
    ]);
    const census = await incidentCensus(FAKE_ENV, censusOver(files));
    expect(census.records).toBe(0);
    expect(census.refused).toHaveLength(1);
  });

  test("the default deps read a real directory and leave ~/.pifleet alone", async () => {
    const subject: IncidentSubject = {
      kind: "service",
      environment: "cni-dev",
      service: "alpha",
    };
    const path = incidentRecordPath(subject, process.env);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, await recordBytes(subject, { state: "provisional" }));
    const census = await incidentCensus(process.env, DEFAULT_CENSUS_DEPS);
    expect(census.by_state.provisional).toBe(1);
    // The fixture root is the temp HOME `beforeEach` installed, so this cannot
    // have been the operator's own tree.
    expect(path.startsWith(process.env["HOME"]!)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The run-tree half of §6.4's driver
// ---------------------------------------------------------------------------

async function seedRun(runId: string): Promise<ReturnType<typeof runPaths>> {
  const run = runPaths(runId, process.env["PIFLEET_RUNS_DIR"]!);
  await mkdir(run.inboxDir, { recursive: true });
  await writeFile(join(run.root, "run.json"), JSON.stringify({ run_id: runId }));
  return run;
}

async function inboxTask(run: ReturnType<typeof runPaths>, taskId: string): Promise<void> {
  await writeFile(join(run.inboxDir, `${taskId}.json`), JSON.stringify({ task_id: taskId }));
}

async function settle(
  run: ReturnType<typeof runPaths>,
  taskId: string,
  worker = TRIAGE_COLLATOR,
): Promise<void> {
  const dir = join(run.workersDir, worker, "tasks");
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, `${taskId}.json`),
    JSON.stringify({
      schema: "pifleet.taskrecord/v1",
      task_id: taskId,
      attempt_id: "a1",
      worker,
      run_id: run.runId,
      epoch: 1,
      verdict: "success",
      reason: "",
      settled_at: "2026-09-06T00:00:00Z",
      tree_hash: null,
    }),
  );
}

describe("§6.6 layer 2: the sweep counter is re-derived from the run tree", () => {
  test("the highest PARENT id wins, and child ids are not parents", async () => {
    const run = await seedRun("2026-09-06T00-00-00Z-aaaa");
    expect(await highestSweepNumber(run)).toBe(0);
    await inboxTask(run, "T-sweep-3");
    await inboxTask(run, "T-sweep-11");
    // Anchored: neither of these is a sweep number, and reading `11` off the
    // collate id would be the same answer for the wrong reason.
    await inboxTask(run, "T-sweep-11-slice2");
    await inboxTask(run, "T-sweep-99-collate");
    expect(await highestSweepNumber(run)).toBe(11);
  });

  test("an absent inbox is 0 rather than a throw", async () => {
    const run = runPaths("no-such-run", process.env["PIFLEET_RUNS_DIR"]!);
    expect(await highestSweepNumber(run)).toBe(0);
  });
});

describe("§6.4's in-flight read, including the case its own sentence gets wrong", () => {
  test("an unsettled collation is in flight and NAMES the task it waits on", async () => {
    const run = await seedRun("2026-09-06T00-00-01Z-bbbb");
    await inboxTask(run, "T-sweep-4");
    await inboxTask(run, "T-sweep-4-collate");
    expect(await inFlightSweep(run)).toEqual({
      sweepId: "T-sweep-4",
      waitingOn: "T-sweep-4-collate",
    });
  });

  test("a settled collation is not in flight", async () => {
    const run = await seedRun("2026-09-06T00-00-02Z-cccc");
    await inboxTask(run, "T-sweep-4");
    await inboxTask(run, "T-sweep-4-collate");
    await settle(run, "T-sweep-4-collate");
    expect(await inFlightSweep(run)).toBeNull();
  });

  test("a parent still working, with no collation yet, is in flight on the parent", async () => {
    const run = await seedRun("2026-09-06T00-00-03Z-dddd");
    await inboxTask(run, "T-sweep-4");
    expect(await inFlightSweep(run)).toEqual({ sweepId: "T-sweep-4", waitingOn: "T-sweep-4" });
  });

  /**
   * **§6.5's ZERO-ROW, which §6.4's literal predicate wedges forever.** No child
   * succeeded, so no collation was dispatched — and *"the `-collate` task has not
   * settled"* is then true for the same reason for all time. An actor reading the
   * sentence literally skips every subsequent tick, notifies once at
   * `max_consecutive_skips` that it has stopped triaging, and never sweeps again,
   * silently, because a skip is not an error.
   *
   * The parent's own record is the discrimination, and this fixture is the one
   * that fails against the literal reading.
   */
  test("a zero-row sweep — parent settled, no collation ever dispatched — is NOT in flight", async () => {
    const run = await seedRun("2026-09-06T00-00-04Z-eeee");
    await inboxTask(run, "T-sweep-4");
    await settle(run, "T-sweep-4");
    expect(await inFlightSweep(run)).toBeNull();
  });

  test("a run that has never swept is not in flight", async () => {
    const run = await seedRun("2026-09-06T00-00-05Z-ffff");
    expect(await inFlightSweep(run)).toBeNull();
  });
});

describe("§6.6 layer 4: per-seat pins, resolved per seat rather than per run", () => {
  test("each seat gets the NEWEST run that materialised it, and an unresolved seat is absent", async () => {
    const older = await seedRun("2026-09-06T00-00-00Z-1111");
    const newer = await seedRun("2026-09-06T00-00-09Z-2222");
    await mkdir(join(older.workersDir, TRIAGE_COLLATOR), { recursive: true });
    await mkdir(join(newer.workersDir, TRIAGE_COLLATOR), { recursive: true });
    await mkdir(join(older.workersDir, "obs-t1"), { recursive: true });

    const runs = await resolveSeatRuns(undefined, process.env);
    expect(runs[TRIAGE_COLLATOR]).toBe(newer.runId);
    // Resolved against its OWN directory: the newest run does not hold obs-t1,
    // and assuming all four seats share one run would answer `2222` here.
    expect(runs["obs-t1"]).toBe(older.runId);
    // A seat with no directory anywhere is ABSENT, never an empty string.
    expect(Object.keys(runs)).not.toContain("obs-t3");
    expect(runs["obs-t3"]).toBeUndefined();
  });
});

describe("buildSweepDriver", () => {
  test("supplies the run-tree members and passes the briefing's four through", async () => {
    const run = await seedRun("2026-09-06T00-00-10Z-3333");
    await inboxTask(run, "T-sweep-7");
    const marker = Symbol("briefing");
    const briefing = {
      openSweep: async () => ({ kind: "opened" as const, marker }),
      dispatchObserver: async () => {},
      join: async () => ({ artifacts: [], blocked: [] }),
      collate: async () => ({ document: null, evidenceRef: "ref" }),
    };
    const driver = buildSweepDriver(run, briefing, process.env);
    expect(await driver.highestSweepNumber()).toBe(7);
    expect(await driver.inFlight()).toEqual({ sweepId: "T-sweep-7", waitingOn: "T-sweep-7" });
    // Identity, not equality: a driver that rebuilt these would be a second
    // implementation of the four members that deliberately have none.
    expect(driver.openSweep).toBe(briefing.openSweep);
    expect(driver.dispatchObserver).toBe(briefing.dispatchObserver);
    expect(driver.join).toBe(briefing.join);
    expect(driver.collate).toBe(briefing.collate);
  });

  test("a sweep with no dispatch request projects an EMPTY partition rather than throwing", async () => {
    const run = await seedRun("2026-09-06T00-00-11Z-4444");
    const driver = buildSweepDriver(
      run,
      {
        openSweep: async () => ({ kind: "opened" as const }),
        dispatchObserver: async () => {},
        join: async () => ({ artifacts: [], blocked: [] }),
        collate: async () => ({ document: null, evidenceRef: "ref" }),
      },
      process.env,
    );
    expect(await driver.readPartition("T-sweep-1")).toEqual([]);
  });
});
