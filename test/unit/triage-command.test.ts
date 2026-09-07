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
import { readFileSync } from "node:fs";
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
import {
  readTriageActorRecord,
  runTriageActor,
  TRIAGE_COLLATOR,
} from "../../src/run/triage-actor.ts";
import { inboxTaskPath, runPaths, type RunPaths } from "../../src/run/paths.ts";
import {
  DISPATCH_REQUEST_SCHEMA,
  dispatchRequestPath,
} from "../../src/run/dispatch-request.ts";
import { TRIAGE_CONSOLE_ASPECTS } from "../../src/run/task-ids.ts";
import { TRIAGE_DOCUMENT_SCHEMA } from "../../src/run/triage-document.ts";
import type { TriagePassOutcome } from "../../src/run/triage-pass.ts";
import {
  observerArtifactPath,
  triageDocumentPath,
  type SweepDispatch,
  type SweepProducerDeps,
} from "../../src/run/triage-envelope.ts";
import type { NotifyRequest } from "../../src/run/triage-notify.ts";
import { statusOutcome } from "../../src/run/triage-notify.ts";
import type { TriageEnvironment, TriageService } from "../../src/run/triage-targets.ts";
import {
  DEFAULT_CENSUS_DEPS,
  NO_COLLATOR_RUN,
  buildSweepDriver,
  buildTriageSweepDriver,
  highestSweepNumber,
  incidentCensus,
  inFlightSweep,
  previousSweepDocument,
  productionIncidentStore,
  productionTriageDeps,
  refuseOnExhaustedBudget,
  register,
  renderStatus,
  resolveCollatorRun,
  resolveSeatRuns,
  soleEnvironment,
  triageStatus,
  type CensusDeps,
  type TriageCommandDeps,
  type TriageProductionEffects,
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

  /*
   * The two tests that used to sit here asserted that the production `--once`
   * and `--poll` REFUSED by name (ISC-809, ISC-850). §13 task 6.1b removes the
   * thing they were about: the production deps now sweep. They are superseded
   * rather than deleted — see the two blocks at the foot of this file, which
   * assert the same POSTURE against the new subject: a console that cannot
   * sweep still refuses by name, and the refusals now name a missing run or a
   * targets file that declares the wrong number of environments rather than a
   * missing producer.
   */
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

// ---------------------------------------------------------------------------
// Task 6.1a — the composition point, and the ONE argument it is still missing
// ---------------------------------------------------------------------------

describe("buildTriageSweepDriver: nine members from one dep set", () => {
  const SERVICES: readonly TriageService[] = [
    {
      name: "routing",
      namespace: "aodapn-routing",
      workload: "routing-api",
      checks: ["rollout", "logs"],
      window: null,
    },
  ];

  function producerDeps(run: ReturnType<typeof runPaths>, sent: string[]): SweepProducerDeps {
    return {
      run,
      environment: "cni-dev",
      services: SERVICES,
      defaultWindowS: 300,
      previousDocument: async () => null,
      dispatch: async (args) => {
        sent.push(`${args.worker}:${args.taskId}`);
        return { kind: "accepted" };
      },
    };
  }

  /**
   * **ALL NINE, by name.** §13 task 6.1a's whole subject is that four of them
   * were a refusing port; asserting the members by name rather than counting
   * them is what makes a tenth — or a quietly dropped fourth — fail here, on
   * `monitor-readonly.test.ts:363-369`'s rule.
   */
  test("every SweepDriver member is present and callable", async () => {
    const run = await seedRun("2026-09-06T00-00-20Z-5555");
    const sent: string[] = [];
    const driver = buildTriageSweepDriver(producerDeps(run, sent), process.env);
    expect(Object.keys(driver).sort()).toEqual([
      "collate",
      "dispatchObserver",
      "highestSweepNumber",
      "inFlight",
      "join",
      "openSweep",
      "readPartition",
      "runs",
    ]);
    // Eight keys, nine members: `SweepDriver` counts `inFlight` and
    // `highestSweepNumber` separately from the six below. Driven rather than
    // merely present, because a member assigned `undefined` also has a key.
    expect(await driver.openSweep("T-sweep-3", "2026-09-06T12:00:00.000Z")).toEqual({
      kind: "opened",
    });
    expect(await driver.join("T-sweep-3")).toEqual({ artifacts: [], blocked: [] });
    expect((await driver.collate("T-sweep-3")).document).toBeNull();
    expect(await driver.readPartition("T-sweep-3")).toEqual([]);
    expect(await driver.highestSweepNumber()).toBe(0);
    expect(await driver.inFlight()).toBeNull();
    expect(sent).toEqual(["tri-1:T-sweep-3", "tri-1:T-sweep-3-collate"]);
  });

  /**
   * The run comes from ONE place. §6.4 refuses two processes because *"two
   * processes that must agree about a run id is a new failure mode with no
   * observable"*, and two PARAMETERS that must agree is the same hazard with a
   * shorter fuse — the run-tree half pinned to one run and the producers to
   * another dispatches into a run nothing joins from.
   */
  test("the run-tree half and the producers cannot be pinned to different runs", async () => {
    const run = await seedRun("2026-09-06T00-00-21Z-6666");
    await inboxTask(run, "T-sweep-9");
    const sent: string[] = [];
    const driver = buildTriageSweepDriver(producerDeps(run, sent), process.env);
    // The run-tree member reads the run the producers were built over, and there
    // is no second argument that could have said otherwise.
    expect(await driver.highestSweepNumber()).toBe(9);
  });
});

// ---------------------------------------------------------------------------
// §13 task 6.1b — the effects are compulsory, and the console sweeps
// ---------------------------------------------------------------------------

/**
 * The environment this fixture fleet sweeps. `default_window: 2m` sits under the
 * default `sweep_deadline_s` of 240 (`cadence_s 300 − reserve_s 60`), so the
 * loader's own cross-file refusals are satisfied by a value rather than by luck.
 *
 * THREE services and three observers, one each, because a partition is only
 * exercised by a fixture it can be wrong about: with one service two of the
 * three seats would have nothing to be assigned and `checkTriagePartition` would
 * be satisfied by a request that named one worker.
 */
const FIXTURE_TARGETS = `
version: 1
environments:
  cni-dev:
    kube_context: gke-cni-dev
    default_window: 2m
    services:
      - {name: routing,        namespace: ns-routing, workload: routing-api, checks: [rollout, logs]}
      - {name: authorization,  namespace: ns-auth,    workload: authz,       checks: [rollout, logs]}
      - {name: authentication, namespace: ns-auth,    workload: authn,       checks: [rollout, logs]}
`;

const FIXTURE_KUBECONFIG = `
apiVersion: v1
kind: Config
contexts:
  - name: gke-cni-dev
    context: {cluster: a, user: b}
current-context: gke-cni-dev
`;

/** `tri-1`'s partition, fixed so the host's completeness check has one answer. */
const SLICE_OF: Readonly<Record<string, string>> = {
  "obs-t1": "routing",
  "obs-t2": "authorization",
  "obs-t3": "authentication",
};

/**
 * `routing` is the one service that reports badly, and the asymmetry is the
 * point: a fixture in which every row is `healthy` proves the sweep ran and
 * nothing about the incident machine, because `advanceIncident` would have
 * nothing to advance. One unhealthy row makes the first pass `provisional` with
 * no notification and the second pass notify exactly once — §12's two
 * highest-value deduplication criteria, reached through the SHIPPED wiring
 * rather than through a hand-built `TriagePassDeps`.
 */
const UNHEALTHY_SERVICE = "routing";

async function writeJson(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, JSON.stringify(value), "utf8");
}

/** One §7.5 row, in the shape `TriageDocumentSchema` accepts. */
function documentRow(service: string, observer: string): Record<string, unknown> {
  return {
    service,
    assessment: service === UNHEALTHY_SERVICE ? "unhealthy" : "healthy",
    // NON-EMPTY, because §6.7 rule 2 downgrades a `healthy` row with no evidence
    // to `unevidenced_healthy`, and a fixture that tripped that would be
    // asserting the downgrade rather than the sweep.
    coverage: [
      { channel: "rollout", result: "answered" },
      { channel: "logs", result: "answered" },
    ],
    selector: `app=${service}`,
    window: "2m",
    evidence_ref: [`${observer}:observer-ops.json#services[0]`],
    observer,
  };
}

/**
 * A dispatch that behaves like the fleet it stands in for, and writes every file
 * the real one would.
 *
 * **This is what "a fixture fleet" has to mean if the sweep is to be real.** The
 * shipped effect writes the durable inbox record, waits for the task to SETTLE,
 * and leaves behind whatever the worker produced. A fixture that only recorded
 * the call would leave `highestSweepNumber` at 0 and `inFlightSweep` at null
 * forever — so a second pass would mint `T-sweep-1` again and the multi-sweep
 * assertions below would be testing one sweep twice.
 *
 * So each call writes three things: the inbox record (the host's), the artifact
 * the addressed worker's turn would produce, and the settled task record (the
 * supervisor's). Nothing here touches a container, a socket or a network.
 */
function fixtureFleetDispatch(run: RunPaths, log: string[], windows: string[]): SweepDispatch {
  let sweepId = "";
  return async ({ taskId, worker, title, brief }) => {
    expect(title.length).toBeGreaterThan(0);
    log.push(`${worker}:${taskId}`);
    await writeJson(inboxTaskPath(run, taskId), { schema: "pifleet.task/v1", task_id: taskId });

    if (worker === TRIAGE_COLLATOR && !taskId.endsWith("-collate")) {
      /*
       * Turn one. The window instant is read back OUT OF THE BRIEF rather than
       * recomputed, which is exactly what §7.2 instructs the collator to do —
       * *"Copy the sweep id and the window instant from this brief … from here
       * and from nowhere else"* — and it is why the observer artifacts below
       * echo a value the HOST minted. A fixture that computed its own would pass
       * §7.4's freshness gate only by coincidence, and would go on passing it if
       * the host stopped minting one.
       */
      sweepId = taskId;
      const window = /- observation window opens at: (\S+)/.exec(brief);
      expect(window, "the sweep brief named no observation window").not.toBeNull();
      windows.push(window![1]!);
      await writeJson(dispatchRequestPath(run.root, TRIAGE_COLLATOR, taskId), {
        schema: DISPATCH_REQUEST_SCHEMA,
        parent_task_id: taskId,
        requests: TRIAGE_CONSOLE_ASPECTS.map((s) => ({
          worker: s.worker,
          title: `${taskId} ${s.worker}`,
          brief: `Observe ${SLICE_OF[s.worker]} and report one row per service.`,
          services: [SLICE_OF[s.worker]!],
        })),
      });
    } else if (worker !== TRIAGE_COLLATOR) {
      // An observer's turn — §7.4's artifact, echoing both host-minted values.
      await writeJson(observerArtifactPath(run, worker, taskId), {
        sweep_id: sweepId,
        window_opened_at: windows[windows.length - 1],
        status: "success",
        services: [
          {
            service: SLICE_OF[worker],
            assessment: documentRow(SLICE_OF[worker]!, worker)["assessment"],
          },
        ],
      });
    } else {
      // Turn two — §7.5's collation document.
      await writeJson(triageDocumentPath(run, taskId), {
        schema: TRIAGE_DOCUMENT_SCHEMA,
        sweep_id: sweepId,
        services: TRIAGE_CONSOLE_ASPECTS.map((s) => documentRow(SLICE_OF[s.worker]!, s.worker)),
        unaccounted: [],
      });
    }

    // The supervisor's settle, which is what makes `SweepDispatch`'s
    // returns-when-settled contract true of this fixture too.
    await writeJson(join(run.workersDir, worker, "tasks", `${taskId}.json`), {
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
    });
    return { kind: "accepted" };
  };
}

interface FixtureFleet {
  readonly run: RunPaths;
  readonly effects: TriageProductionEffects;
  /** `worker:taskId`, in dispatch order. */
  readonly dispatched: string[];
  readonly delivered: NotifyRequest[];
  /** How many times the saturation probe was reached. MUST stay 0. */
  readonly probes: { count: number };
}

/**
 * A run tree, two tracked triage files, a kubeconfig, and the eight effects the
 * composition root would otherwise build.
 *
 * `env` is the CURRENT `process.env` snapshot, which `beforeEach` has already
 * pointed at a fresh temp `HOME` and `PIFLEET_RUNS_DIR` — so every incident
 * record this sweep writes lands under the temp tree and `~/.pifleet` is never
 * opened.
 */
async function fixtureFleet(runId: string): Promise<FixtureFleet> {
  const base = process.env["HOME"]!;
  const run = runPaths(runId, process.env["PIFLEET_RUNS_DIR"]!);
  await mkdir(run.inboxDir, { recursive: true });
  await writeFile(join(run.root, "run.json"), JSON.stringify({ run_id: runId }));
  // The collator's directory is what `resolveCollatorRun` scans for.
  for (const w of [TRIAGE_COLLATOR, ...TRIAGE_CONSOLE_ASPECTS.map((s) => s.worker)]) {
    await mkdir(join(run.workersDir, w), { recursive: true });
  }

  const configDir = join(base, "fleet");
  await mkdir(join(configDir, "triage"), { recursive: true });
  await writeFile(join(configDir, "triage", "targets.yaml"), FIXTURE_TARGETS);
  const kubeconfig = join(configDir, "kubeconfig.yaml");
  await writeFile(kubeconfig, FIXTURE_KUBECONFIG);

  const dispatched: string[] = [];
  const delivered: NotifyRequest[] = [];
  const windows: string[] = [];
  const probes = { count: 0 };

  const effects: TriageProductionEffects = {
    dispatchFor: (r, opts) => {
      // §7.8's `sweep_deadline_s` — `cadence_s − reserve_s` — reaches the effect
      // as a bound, which is the half of the split task 6.1b decided: the
      // deadline is the console's decision, the dispatch is the root's
      // capability.
      expect(opts.settleDeadlineMs).toBe(240_000);
      return fixtureFleetDispatch(r, dispatched, windows);
    },
    isCollatorLive: async () => true,
    triageFiles: {
      targets: join(configDir, "triage", "targets.yaml"),
      console: join(configDir, "triage", "console.yaml"),
    },
    kubeconfigPath: kubeconfig,
    endpoint: { provider: "omlx", model: "gpt-oss-20b-MXFP4-Q8" },
    probe: async () => {
      probes.count += 1;
      throw new Error("the fixture probe must never be reached — it would be a real POST");
    },
    transport: async (req) => {
      delivered.push(req);
      return statusOutcome(200, Date.now());
    },
    env: { ...process.env },
  };

  return { run, effects, dispatched, delivered, probes };
}

describe("§13 task 6.1b: the effects the console may not build are COMPULSORY", () => {
  /**
   * **The arity IS the guard**, and it is the repository's own instrument for
   * this exact class: `saturationVerdict` takes its probe as a required
   * parameter and the suite asserts `saturationVerdict.length`, because *"a
   * default would drop the arity and redden"*.
   *
   * Here the stake is the read-only ruling. The per-observer dispatch is a
   * capability §12's block forbids this console's own modules to hold; a
   * defaulted `effectsFor` would let a `productionTriageDeps()` exist somewhere,
   * and whatever that returned would either refuse (a hole in the wiring layer
   * §3.3 says the coverage gate keeps catching) or build the effect here (a
   * second allowlist entry, which ISC-826 refuses).
   */
  test("productionTriageDeps cannot be called without its effects", () => {
    expect(productionTriageDeps.length).toBe(1);
  });

  /**
   * The same guard one layer out. `register` defaulted to `productionTriageDeps`
   * while that took no arguments; it cannot now, and asserting the arity is what
   * stops a refusing default being reintroduced as a convenience.
   *
   * This is also what makes `src/cli/index.ts` register this command by NAME
   * rather than through its uniform `for (const m of modules) m.register(program)`
   * loop — see `test/unit/cli.test.ts`.
   */
  test("register cannot put triage on a program without a deps factory", () => {
    expect(register.length).toBe(2);
  });

  /**
   * **THE ANTI-CRITERION, on the raw bytes.**
   *
   * §13 task 6.1b: *"`cli/commands/triage.ts` still names neither `dispatch.ts`
   * nor `LedgerWriter`, so the capability arrived by injection and not by
   * import."* `test/unit/triage-readonly.test.ts` checks the second spelling
   * over COMMENT-STRIPPED source, which is right for a guard that must not fail
   * on a docblock quoting a verb. This assertion is deliberately stricter — the
   * file as it sits on disk, comments included — because there is no reason for
   * this module to utter either token at all, and a prose mention is how the
   * next reader learns that reaching for it is normal.
   *
   * `dispatch-request.ts` is NOT a false positive: "dispatch.ts" is not a
   * substring of it. That is asserted below rather than assumed, because the
   * whole probe would be worthless if the two collided.
   */
  test("the console's command names neither banned spelling, comments included", () => {
    const source = readFileSync(
      join(import.meta.dir, "..", "..", "src", "cli", "commands", "triage.ts"),
      "utf8",
    );
    expect(source).not.toContain("dispatch.ts");
    expect(source).not.toContain("LedgerWriter");
    // The premise: the module DOES hold the one permitted exception, so the two
    // absences above are about the effect and not about a file that imports
    // nothing.
    expect(source).toContain("dispatch-request.ts");
    expect("dispatch-request.ts").not.toContain("dispatch.ts");
  });
});

describe("§13 task 6.1b: pifleet triage --once performs one real sweep", () => {
  /**
   * **The acceptance criterion, end to end through the shipped command.**
   *
   * Everything between `pifleet triage --once` and the incident records on disk
   * is production code: `productionTriageDeps` resolves the run, loads and
   * fences both tracked files, seeds the cursor from §7.7's record, builds all
   * nine `SweepDriver` members and runs `triagePass`. The only things injected
   * are the effects `TriageProductionEffects` names, and each is injected
   * because building it here would either reach the network or reach a module
   * §12's read-only block forbids.
   */
  test("dispatches the sweep, all three observers and the collation, in order", async () => {
    const fleet = await fixtureFleet("2026-09-06T01-00-00Z-1111");
    const deps = productionTriageDeps(async () => fleet.effects);
    const { err, out } = await runTriage(["--once"], deps);

    expect(err).toBeNull();
    expect(fleet.dispatched).toEqual([
      `${TRIAGE_COLLATOR}:T-sweep-1`,
      "obs-t1:T-sweep-1-slice1",
      "obs-t2:T-sweep-1-slice2",
      "obs-t3:T-sweep-1-slice3",
      `${TRIAGE_COLLATOR}:T-sweep-1-collate`,
    ]);
    expect(out).toContain("T-sweep-1: swept 3 observers");
    // §12's closing anti-criterion: no criterion here requires a real model.
    expect(fleet.probes.count).toBe(0);
  });

  /**
   * The pass's own value, which is what `--json` publishes and what the incident
   * machine acted on. Asserted separately from the dispatch order because they
   * fail for different reasons: an empty `dispatched[]` is a partition that was
   * refused, and an empty `written[]` with a full `dispatched[]` is a sweep
   * whose artifacts never reached the assessment.
   */
  test("a first unhealthy observation is provisional and notifies NOTHING", async () => {
    const fleet = await fixtureFleet("2026-09-06T01-00-01Z-2222");
    const outcome = await productionTriageDeps(async () => fleet.effects).pass();

    expect(outcome.kind).toBe("swept");
    expect([...outcome.dispatched]).toEqual(["obs-t1", "obs-t2", "obs-t3"]);
    // §12: *"A first `unhealthy` observation notifies nothing."*
    expect(outcome.notifications).toEqual([]);
    expect(fleet.delivered).toEqual([]);
    const routing = outcome.written.find(
      (r) => r.subject.kind === "service" && r.subject.service === UNHEALTHY_SERVICE,
    );
    expect(routing?.state).toBe("provisional");
    // And it really landed on disk, under the temp HOME rather than the
    // operator's own — `incidentRecordRoot` is `dirname(runsRoot(env))/triage`.
    const onDisk = incidentRecordPath(
      { kind: "service", environment: "cni-dev", service: UNHEALTHY_SERVICE },
      fleet.effects.env,
    );
    expect(onDisk.startsWith(process.env["HOME"]!)).toBe(true);
    expect(readFileSync(onDisk, "utf8")).toContain("provisional");
  });

  /**
   * **Two passes over ONE deps object, which is the only way to see the carried
   * state at all.**
   *
   * §12's second incident criterion — *"A second consecutive `unhealthy`
   * notifies exactly once"* — is a claim about two passes, and it is reached
   * here through the shipped wiring rather than through a hand-built
   * `TriagePassDeps`. Three things had to be right for it to pass and each fails
   * differently: the cursor has to advance (or the second pass mints `T-sweep-1`
   * again and the epoch fence eats it), the incident record has to be re-loaded
   * from disk (or the second `unhealthy` is another first one), and the fixture
   * fleet has to settle its collation (or the second pass SKIPS on an in-flight
   * sweep and notifies nothing for a reason that looks the same).
   */
  test("a second consecutive unhealthy notifies exactly once, and it is delivered", async () => {
    const fleet = await fixtureFleet("2026-09-06T01-00-02Z-3333");
    const deps = productionTriageDeps(async () => fleet.effects);

    const first = await deps.pass();
    expect(first.kind).toBe("swept");
    expect(first.sweepId).toBe("T-sweep-1");

    const second = await deps.pass();
    // NOT a skip: the fixture settled the collation, so the sweep is over.
    expect(second.kind).toBe("swept");
    expect(second.sweepId).toBe("T-sweep-2");
    expect(second.notifications.length).toBe(1);
    expect(second.notifications[0]?.kind).toBe("opened");
    expect(fleet.delivered.length).toBe(1);
    // The ntfy adapter carries the announcement title in a HEADER, so this is
    // the request field an operator's phone actually shows.
    const title = fleet.delivered[0]?.headers["Title"] ?? "";
    expect(title).toContain(UNHEALTHY_SERVICE);
    // The two healthy services stayed quiet, so the one notification is about
    // the service that reported badly rather than about the sweep happening.
    expect(title).not.toContain("authentication");
  });

  /**
   * **The `--poll` half, driven once with no timer.**
   *
   * ISC-809's second clause asserted that the production LOOP refused up front
   * rather than spinning on a refusing pass. It no longer refuses, so the thing
   * that needs pinning is that it works — and the loop wiring is a layer with
   * four members nothing else drives: the collator-liveness binding, the actor
   * identity (whose `started` capture has two failure shapes, ISC-272), the
   * cursor writer, and the log. §3.3: *"the command-wiring layer is the layer
   * the coverage gate keeps catching."*
   *
   * **`cadenceS: 1` and an abort inside the pass, so the wait is one second and
   * is bounded by the assertion below.** §13 task 6.1's *"no test starts the
   * loop"* forbids a test that WAITS on one — `relay.ts:82-88`'s *"a test that
   * measures its own timeout"* — and `runTriageActor` checks `isStopped`
   * immediately after `sleep`, so aborting during the first pass makes the loop
   * provably terminate after it with no timer outstanding. The `sleep` is the
   * shipped `setTimeout` rather than an injected one, which is the point: this
   * test drives the production wiring, not a rebuild of it.
   *
   * **One and not zero**, because `TriageActorRecordSchema` requires
   * `cadence_s` to be POSITIVE and `writeTriageActorRecord` throws on a record
   * the schema rejects — which `runTriageActor` catches into
   * `record_write_failed` rather than ending the actor. A zero cadence would
   * therefore have driven the loop, written nothing, and left every assertion
   * below testing a record that was never saved. Measured, not assumed: it is
   * how the first draft of this test failed.
   */
  test("--poll's loop runs one pass, persists §7.7's record, and stops on its signal", async () => {
    const fleet = await fixtureFleet("2026-09-06T01-00-06Z-7777");
    const deps = productionTriageDeps(async () => fleet.effects);
    const stop = new AbortController();

    const started = Date.now();
    const exit = await deps.loop(
      async () => {
        const outcome = await deps.pass();
        stop.abort();
        return outcome;
      },
      { cadenceS: 1, signal: stop.signal },
    );
    expect(exit).toEqual({ kind: "stopped", passes: 1 });
    // One cadence, not two: a loop that ignored the signal would sit here.
    expect(Date.now() - started).toBeLessThan(10_000);
    // The sweep really happened through the loop, not only through `--once`.
    expect(fleet.dispatched.length).toBe(5);

    // §7.7's record, written by the PRODUCTION `saveCursor`.
    const record = await readTriageActorRecord(fleet.effects.env);
    expect(record.kind).toBe("ok");
    if (record.kind !== "ok") return;
    expect(record.record.run_id).toBe(fleet.run.runId);
    expect(record.record.sweep_cursor).toBe(1);
    expect(record.record.pid).toBe(process.pid);
    expect(record.record.cadence_s).toBe(1);
    // And the log the actor is required to have — §9.15 surface 2.
    expect(readFileSync(record.record.log_path, "utf8")).toContain("actor_started");
  });

  /**
   * `--json` publishes the pass, and the wire tag is what a machine caller
   * switches on. Driven through the production deps rather than a stub, because
   * the shape of a REAL outcome is the thing a consumer will meet.
   */
  test("--json emits the pass under its wire tag", async () => {
    const fleet = await fixtureFleet("2026-09-06T01-00-03Z-4444");
    const { err, out } = await runTriage(
      ["--once", "--json"],
      productionTriageDeps(async () => fleet.effects),
    );
    expect(err).toBeNull();
    const doc = JSON.parse(out) as { schema: string; kind: string; dispatched: string[] };
    expect(doc.schema).toBe("pifleet.triagepass/v1");
    expect(doc.kind).toBe("swept");
    expect(doc.dispatched).toEqual(["obs-t1", "obs-t2", "obs-t3"]);
  });
});

describe("§13 task 6.1b: what the production deps still REFUSE, and by name", () => {
  /**
   * ISC-809's posture, transplanted onto its new subject. The old refusal said
   * *"this console has no dispatch"*; that is now false. What is still true is
   * that a console with nowhere to sweep must say so rather than report a sweep
   * that did not happen — `relay.ts`'s recorded rule, *"a stub that dispatched
   * nothing and returned success would be indistinguishable from a working
   * relay"*.
   *
   * The premise is asserted first: on a run tree that DOES hold `tri-1` the same
   * deps sweep. Without it a refusal here would be satisfied by a console that
   * refuses everything.
   */
  test("no run holding tri-1 is a refusal that names the seat and says --status works", async () => {
    const present = await fixtureFleet("2026-09-06T01-00-04Z-5555");
    const { err: swept } = await runTriage(
      ["--once"],
      productionTriageDeps(async () => present.effects),
    );
    expect(swept).toBeNull();

    // The same fixture, pointed at a runs root that holds nothing.
    const orphaned: TriageProductionEffects = {
      ...present.effects,
      env: { ...present.effects.env, PIFLEET_RUNS_DIR: join(process.env["HOME"]!, "no-such-runs") },
    };
    const { err: refused } = await runTriage(
      ["--once"],
      productionTriageDeps(async () => orphaned),
    );
    expect(refused).toBeInstanceOf(CliError);
    expect((refused as CliError).message).toBe(NO_COLLATOR_RUN);
    expect((refused as CliError).exitCode).toBe(EXIT.USAGE);
    expect(NO_COLLATOR_RUN).toContain(TRIAGE_COLLATOR);
    expect(NO_COLLATOR_RUN).toContain("--status works");
  });

  /**
   * `resolveCollatorRun` picks the newest run that materialised `tri-1` and not
   * simply the newest run — §6.6 layer 4's D4, *"a console is four runs and the
   * newest is not necessarily the collator's"*.
   */
  test("the run is the newest one holding tri-1, not the newest run", async () => {
    const older = await fixtureFleet("2026-09-06T02-00-00Z-aaaa");
    // A NEWER run that holds only an observer. Recency alone would pick it.
    const newer = runPaths("2026-09-06T03-00-00Z-bbbb", process.env["PIFLEET_RUNS_DIR"]!);
    await mkdir(join(newer.workersDir, "obs-t1"), { recursive: true });
    expect((await resolveCollatorRun(process.env)).runId).toBe(older.run.runId);
  });

  /**
   * **One sweep is ONE environment, and both wrong counts are refused by name.**
   *
   * `triage-pass.ts` states the limit — *"`ConsoleHealthFacts` takes a LIST of
   * environments, which is the seam a multi-environment console would grow
   * into; nothing in Phase 6 asks for it"* — and a loader that silently took the
   * first would sweep one environment and report health for a fleet.
   */
  test("a targets file that declares zero or two environments is refused by name", () => {
    const env = (kube: string): TriageEnvironment =>
      ({ kube_context: kube, default_window: 120, services: [] }) as unknown as TriageEnvironment;
    expect(soleEnvironment({ "cni-dev": env("a") }).name).toBe("cni-dev");
    expect(() => soleEnvironment({})).toThrow(/declares 0 environments \(none\)/);
    expect(() => soleEnvironment({ "cni-dev": env("a"), "cni-verify": env("b") })).toThrow(
      /declares 2 environments \(cni-dev, cni-verify\)/,
    );
  });
});

describe("§6.10 exit 5: the budget gate is a READ the console makes for itself", () => {
  const ARGS = { taskId: "T-sweep-1", worker: TRIAGE_COLLATOR, title: "t", brief: "b" };

  /**
   * With no `budget.json` the gate is transparent, which is the ordinary state:
   * the file is written by the `--auto` scheduler's `onChange` and by nothing
   * else, so a console run started by `scripts/triage` has none. **That is
   * reported as a gap in §6.10's own wiring rather than papered over here** —
   * this test pins the mapping, not a claim that the notification can fire.
   */
  test("no budget file is not a refusal — the dispatch goes through", async () => {
    const run = runPaths("2026-09-06T04-00-00Z-cccc", process.env["PIFLEET_RUNS_DIR"]!);
    const calls: string[] = [];
    const gated = refuseOnExhaustedBudget(run, async (a) => {
      calls.push(a.taskId);
      return { kind: "accepted" };
    });
    expect(await gated(ARGS)).toEqual({ kind: "accepted" });
    expect(calls).toEqual(["T-sweep-1"]);
  });

  /**
   * A halted budget refuses BEFORE the effect, and the reason carries the three
   * numbers an operator needs — §6.10: *"the console has a hard lifetime
   * measured in tokens … **Nothing announces that today**, so this design makes
   * it a notification."*
   *
   * `calls` is asserted EMPTY rather than the outcome asserted alone: the whole
   * value of a gate is that the thing behind it did not run, and an
   * implementation that dispatched and then relabelled the result would satisfy
   * an outcome-only assertion.
   */
  test("a halted budget is budget_exhausted, and the dispatch is never reached", async () => {
    const run = runPaths("2026-09-06T04-00-01Z-dddd", process.env["PIFLEET_RUNS_DIR"]!);
    await writeJson(run.budgetJson, {
      schema: "pifleet.budget/v1",
      run_id: run.runId,
      tokens_ceiling: 6_000_000,
      tokens_spent: 6_000_001,
      halted_at: "2026-09-06T04:00:00.000Z",
      halted_reason: "tokens_ceiling crossed",
    });
    const calls: string[] = [];
    const gated = refuseOnExhaustedBudget(run, async (a) => {
      calls.push(a.taskId);
      return { kind: "accepted" };
    });
    const outcome = await gated(ARGS);
    expect(outcome.kind).toBe("budget_exhausted");
    expect(outcome.kind === "budget_exhausted" && outcome.reason).toContain(
      "tokens_ceiling crossed",
    );
    expect(outcome.kind === "budget_exhausted" && outcome.reason).toContain("6000001 of 6000000");
    expect(calls).toEqual([]);
  });

  /**
   * A budget that is present and NOT halted is the discriminating case: an
   * implementation that refused on the file's mere existence would pass both
   * tests above and stop every sweep on a run that had a ceiling.
   */
  test("a present but unhalted budget does not refuse", async () => {
    const run = runPaths("2026-09-06T04-00-02Z-eeee", process.env["PIFLEET_RUNS_DIR"]!);
    await writeJson(run.budgetJson, {
      schema: "pifleet.budget/v1",
      run_id: run.runId,
      tokens_ceiling: 6_000_000,
      tokens_spent: 12,
      halted_at: null,
    });
    expect(await refuseOnExhaustedBudget(run, async () => ({ kind: "accepted" }))(ARGS)).toEqual({
      kind: "accepted",
    });
  });
});

describe("§6.6 layer 3: the previous sweep's document, and the store that keeps records", () => {
  test("a console that has never swept has no previous document", async () => {
    const fleet = await fixtureFleet("2026-09-06T05-00-00Z-ffff");
    expect(await previousSweepDocument(fleet.run)).toBeNull();
  });

  /**
   * After one sweep the previous document is the one THAT sweep collated, found
   * from the run tree rather than from a cursor — so a restarted actor with an
   * empty record still carries state forward (D12).
   */
  test("after a sweep it is that sweep's collation, read from the run tree", async () => {
    const fleet = await fixtureFleet("2026-09-06T05-00-01Z-0001");
    await productionTriageDeps(async () => fleet.effects).pass();
    const doc = await previousSweepDocument(fleet.run);
    expect(doc?.sweep_id).toBe("T-sweep-1");
    expect(doc?.services.map((s) => s.service).sort()).toEqual([
      "authentication",
      "authorization",
      "routing",
    ]);
  });

  /**
   * An unreadable collation is `null` rather than a throw: a worker's malformed
   * document must not stop the NEXT sweep being dispatched, and `null` is the
   * value `renderSweepEnvelope` already treats as *"there is no previous
   * state"*.
   */
  test("a malformed collation is null, not a thrown pass", async () => {
    const fleet = await fixtureFleet("2026-09-06T05-00-02Z-0002");
    await productionTriageDeps(async () => fleet.effects).pass();
    await writeFile(triageDocumentPath(fleet.run, "T-sweep-1-collate"), "{not json", "utf8");
    expect(await previousSweepDocument(fleet.run)).toBeNull();
  });

  /** The store round-trips through the temp HOME and nothing else. */
  test("the incident store loads back exactly what it saved", async () => {
    const env = { ...process.env };
    const store = productionIncidentStore(env);
    const subject: IncidentSubject = {
      kind: "service",
      environment: "cni-dev",
      service: "routing",
    };
    /*
     * A MISSING file is a FRESH record, not a refusal, and the distinction is
     * §7.6's whole posture: *"A console watching nine services has nine missing
     * files on its first sweep, which is the ordinary state and costs nothing; a
     * file that exists and cannot be read is a fact about a service whose
     * incident state is now unknown."* Asserted here so the store's `load` is
     * pinned as a pass-through of that decision rather than a second one.
     */
    const before = await store.load(subject);
    expect(before.kind).toBe("ok");
    expect(before.kind === "ok" && before.record.state).toBe("clear");
    expect(before.kind === "ok" && before.record.sweep_count).toBe(0);

    await store.save({ ...freshIncidentRecord(subject), state: "firing", sweep_count: 7 });
    const read = await store.load(subject);
    expect(read.kind).toBe("ok");
    expect(read.kind === "ok" && read.record.state).toBe("firing");
    expect(read.kind === "ok" && read.record.sweep_count).toBe(7);

    // And a file that EXISTS and cannot be parsed refuses, which is the arm the
    // fresh-record default must never absorb.
    await writeFile(incidentRecordPath(subject, env), "{not json", "utf8");
    expect((await store.load(subject)).kind).toBe("refused");
  });
});
