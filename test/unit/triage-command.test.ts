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
 *   - **The run-tree half of §6.4's driver** — including the zero-row case §6.4's
 *     own sentence gets wrong, and §13 task 6.4a's `resumableSweep`, which is the
 *     read that tells that zero-row apart from a sweep abandoned before its
 *     collation. Both are asserted against BOTH functions on every fixture,
 *     because they are indistinguishable through `inFlightSweep` by design.
 *
 * **The incident census moved out of this file with §13 task 6.2a** and is tested
 * in `triage-incident.test.ts`, beside `incidentRecordPath` and
 * `parseIncidentRecord` — the two things it reads with. What stays here is
 * `--status`, which is a CONSUMER of the census: `triageStatus` still takes a
 * `CensusDeps` and is still driven over a `Map`.
 *
 * ## No test here starts a clock, reaches a network, or touches `~/.pifleet`
 *
 * §12's closing anti-criterion: *"no criterion in this block requires a real
 * terminal, a real model, a real cluster, or the network."* Every transport is
 * injected. The `--status` tests reach no filesystem at all — `CensusDeps` is
 * backed by a `Map` — and the run-tree tests use `mkdtemp` with
 * `PIFLEET_RUNS_DIR` and `HOME` both redirected, so `incidentRecordRoot`, which
 * is keyed off the runs root's parent, cannot resolve to the operator's own.
 *
 * The loop is driven ONCE, with an injected `sleep` that aborts the signal before
 * it resolves — `runTriageActor` checks `isStopped` immediately after `sleep`
 * (`triage-actor.ts:604-608`), so the loop provably terminates after one pass with
 * no timer running. §13 task 6.1's *"no test starts the loop"* forbids a test that
 * WAITS on one; a test that measures its own timeout is the failure it names.
 */

import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { Command } from "commander";
import { existsSync, readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { buildProgram, CliError } from "../../src/cli/index.ts";
import { EXIT } from "../../src/contracts.ts";
import {
  freshIncidentRecord,
  incidentRecordPath,
  type CensusDeps,
  type IncidentSubject,
} from "../../src/run/triage-incident.ts";
import { freshDeliveryState, reporterStatus } from "../../src/run/triage-notify.ts";
import {
  acquireTriageActorLock,
  readTriageActorRecord,
  runTriageActor,
  triageActorLockPath,
  triageActorLogPath,
  triageActorRecord,
  triageActorRecordPath,
  triageCursorPath,
  readTriageSweepCursor,
  writeTriageSweepCursor,
  writeTriageActorRecord,
  TRIAGE_COLLATOR,
  type TriageConsolePorts,
} from "../../src/run/triage-actor.ts";
import {
  inboxTaskPath,
  runIdsAscending,
  runPaths,
  runsRoot,
  type RunPaths,
} from "../../src/run/paths.ts";
import {
  DISPATCH_REQUEST_SCHEMA,
  TRIAGE_CONSOLE_ROSTER,
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
  NO_COLLATOR_RUN,
  buildSweepDriver,
  buildTriageSweepDriver,
  highestSweepNumber,
  inFlightSweep,
  resumableSweep,
  previousSweepDocument,
  productionIncidentStore,
  productionTriageDeps,
  refuseOnExhaustedBudget,
  register,
  renderStatus,
  readSweepPartition,
  resolveCollatorRun,
  resolveSeatRuns,
  soleEnvironment,
  triageStatus,
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
  /** ISC-1168: this fixture is an ordinary sweep, so it abandoned nothing. */
  expired: null,
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

/**
 * `TriageConsolePorts` for a test that is about something else — §13 task 6.5b
 * made `TriageActorDeps.ports` REQUIRED, so a test driving the shipped
 * `runTriageActor` has to supply one.
 *
 * **Every member is inert, and the two privileged ones THROW.** A unit suite
 * that recycled a worker would tear down a real container it cannot rebuild, so
 * `downSeat` and `upSeat` are not stubs that quietly succeed — they are the same
 * posture `fixtureFleet`'s saturation probe takes (*"the fixture probe must never
 * be reached — it would be a real POST"*), for the same reason.
 *
 * `acquireLock` hands back a lock it never took: a real
 * {@link acquireTriageActorLock} would write under `$HOME/.pifleet`, and while
 * `beforeEach` redirects `HOME`, a lock is the one piece of state whose leak can
 * wedge an operator's machine. `seats: []` and `sweepInFlight: true` are what
 * make this ports object decide nothing — the gate finds no unresolved pin and
 * the boundary never opens.
 */
const inertPorts = (): TriageConsolePorts => ({
  acquireLock: async () => ({ release: async () => {} }),
  lockPath: "/fixture/triage-relay.lock",
  seats: [],
  recycleAfterSweeps: 0,
  sweepInFlight: async () => true,
  seatRuns: async () => ({}),
  downSeat: async (seat) => {
    throw new Error(`the inert ports must never recycle: down ${seat}`);
  },
  upSeat: async (seat) => {
    throw new Error(`the inert ports must never recycle: up ${seat}`);
  },
  resume: async () => null,
  /*
   * §6.10's ports, inert like the rest: a unit fixture must never read a real
   * `budget.json` or write one. `ceiling` answers a number nothing crosses and
   * `publish` records nothing, so this object still decides NOTHING — which is
   * what the docblock above promises of every member.
   *
   * Required rather than omitted as of 2026-09-07: `TriageConsolePorts.budget`
   * stopped being optional when the composition root grew
   * `budget: productionConsoleBudgetPorts(e.env)`, and this is the `tsc` error
   * that change was supposed to produce.
   */
  budget: {
    ceiling: async () => Number.MAX_SAFE_INTEGER,
    persisted: async () => null,
    seatTokens: async () => 0,
    publish: async () => {},
  },
});

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
              ports: inertPorts(),
            },
            /*
             * `--poll 300` was typed, so §13 task 6.9's nullable cadence is a
             * NUMBER on this path — asserted rather than coalesced, because a
             * `?? 300` here would hide the very defect that task closed: the
             * override and the schema default are the same number.
             */
            {
              cadenceS: (() => {
                expect(opts.cadenceS).toBe(300);
                return opts.cadenceS ?? 0;
              })(),
              runId: "r",
              signal: controller.signal,
            },
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
// The run-tree half of §6.4's driver
// ---------------------------------------------------------------------------

async function seedRun(runId: string): Promise<ReturnType<typeof runPaths>> {
  const run = runPaths(runId, process.env["PIFLEET_RUNS_DIR"]!);
  await mkdir(run.inboxDir, { recursive: true });
  await writeFile(join(run.root, "run.json"), JSON.stringify({ run_id: runId }));
  return run;
}

/**
 * The host's own inbox envelope. `dispatched_at` is OPTIONAL here on purpose:
 * `pifleet.task/v1` always carries it in production (`dispatch.ts` fills it
 * rather than an author), but §13 task 6.4a has to answer for a file that has
 * been truncated or hand-edited, and a fixture that could not spell the absence
 * could not test the refusal.
 */
async function inboxTask(
  run: ReturnType<typeof runPaths>,
  taskId: string,
  dispatchedAt?: string,
): Promise<void> {
  await writeFile(
    join(run.inboxDir, `${taskId}.json`),
    JSON.stringify(
      dispatchedAt === undefined
        ? { task_id: taskId }
        : { task_id: taskId, dispatched_at: dispatchedAt },
    ),
  );
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
      // `inboxTask` wrote no `dispatched_at`, so the sweep cannot be dated and
      // ISC-1168's bound will never expire it. Undateable is not expired.
      dispatchedAt: null,
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
    expect(await inFlightSweep(run)).toEqual({
      sweepId: "T-sweep-4",
      waitingOn: "T-sweep-4",
      dispatchedAt: null,
    });
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

/**
 * §13 task 6.4a — the read ISC-868 was filed open for, over a real run tree.
 *
 * The two sweeps this narrows to are indistinguishable through `inFlightSweep`
 * BY DESIGN — §6.4's corrected predicate collapses *"parent settled, no
 * collation"* into `null` so a §6.5 zero-row cannot wedge the actor (ISC-805) —
 * so every fixture below is asserted against BOTH functions. A `resumableSweep`
 * that merely re-derived the in-flight answer would pass a file that only
 * checked one of them.
 */
describe("§13 task 6.4a: the run tree's read for a sweep abandoned before collation", () => {
  const DISPATCHED_AT = "2026-09-06T00:00:00.000Z";

  test("a settled parent with no collate task is RESUMABLE, and carries its dispatch time", async () => {
    const run = await seedRun("2026-09-06T00-01-00Z-a1a1");
    await inboxTask(run, "T-sweep-4", DISPATCHED_AT);
    await settle(run, "T-sweep-4");
    expect(await resumableSweep(run)).toEqual({
      sweepId: "T-sweep-4",
      dispatchedAt: DISPATCHED_AT,
    });
    // The premise this whole task rests on: the in-flight port cannot see it.
    expect(await inFlightSweep(run)).toBeNull();
  });

  /**
   * A collation that was dispatched at ALL belongs to `inFlightSweep`, settled or
   * not. Resuming here would race `tri-1` to write the same document.
   */
  test("a dispatched collation is NOT resumable — settled or unsettled", async () => {
    const live = await seedRun("2026-09-06T00-01-01Z-b2b2");
    await inboxTask(live, "T-sweep-4", DISPATCHED_AT);
    await settle(live, "T-sweep-4");
    await inboxTask(live, "T-sweep-4-collate", DISPATCHED_AT);
    expect(await resumableSweep(live)).toBeNull();
    expect(await inFlightSweep(live)).toEqual({
      sweepId: "T-sweep-4",
      waitingOn: "T-sweep-4-collate",
      // This fixture DID date its envelope, so the same read that feeds
      // `resumableSweep` feeds ISC-1168's bound — one reader, two callers.
      dispatchedAt: DISPATCHED_AT,
    });

    const done = await seedRun("2026-09-06T00-01-02Z-c3c3");
    await inboxTask(done, "T-sweep-4", DISPATCHED_AT);
    await settle(done, "T-sweep-4");
    await inboxTask(done, "T-sweep-4-collate", DISPATCHED_AT);
    await settle(done, "T-sweep-4-collate");
    expect(await resumableSweep(done)).toBeNull();
    expect(await inFlightSweep(done)).toBeNull();
  });

  /**
   * The parent still working is the worker's turn, not the host's — and it is
   * the case `inFlightSweep` already owns, so answering it twice would give the
   * pass two contradictory instructions about one sweep.
   */
  test("a parent that has NOT settled is in flight, never resumable", async () => {
    const run = await seedRun("2026-09-06T00-01-03Z-d4d4");
    await inboxTask(run, "T-sweep-4", DISPATCHED_AT);
    expect(await resumableSweep(run)).toBeNull();
    expect(await inFlightSweep(run)).toEqual({
      sweepId: "T-sweep-4",
      waitingOn: "T-sweep-4",
      dispatchedAt: DISPATCHED_AT,
    });
  });

  /**
   * **A sweep that cannot be DATED is not resumed.** §7.4's echo is computed
   * against `dispatched_at`, so a resumed sweep dated from `now` would report
   * every observer that answered correctly as `stale_window`. The cost of the
   * refusal is the one wasted cadence this whole task is arguing about, which is
   * the cheap side of the trade.
   */
  test("an envelope with no readable dispatched_at refuses rather than guessing", async () => {
    const missing = await seedRun("2026-09-06T00-01-04Z-e5e5");
    await inboxTask(missing, "T-sweep-4");
    await settle(missing, "T-sweep-4");
    expect(await resumableSweep(missing)).toBeNull();

    const unparsable = await seedRun("2026-09-06T00-01-05Z-f6f6");
    await inboxTask(unparsable, "T-sweep-4", "the day before yesterday");
    await settle(unparsable, "T-sweep-4");
    expect(await resumableSweep(unparsable)).toBeNull();

    const truncated = await seedRun("2026-09-06T00-01-06Z-0707");
    await writeFile(join(truncated.inboxDir, "T-sweep-4.json"), '{"task_id":"T-sweep');
    await settle(truncated, "T-sweep-4");
    expect(await resumableSweep(truncated)).toBeNull();
  });

  test("a run that has never swept has nothing to resume", async () => {
    const run = await seedRun("2026-09-06T00-01-07Z-1818");
    expect(await resumableSweep(run)).toBeNull();
  });

  /**
   * The read is anchored on the HIGHEST parent, the same one `inFlightSweep`
   * reads, so the two can never disagree about which sweep they are describing.
   */
  test("it answers for the highest sweep, not for an older settled one", async () => {
    const run = await seedRun("2026-09-06T00-01-08Z-2929");
    await inboxTask(run, "T-sweep-4", DISPATCHED_AT);
    await settle(run, "T-sweep-4");
    await inboxTask(run, "T-sweep-4-collate", DISPATCHED_AT);
    await settle(run, "T-sweep-4-collate");
    await inboxTask(run, "T-sweep-5", "2026-09-06T00:05:00.000Z");
    await settle(run, "T-sweep-5");
    expect(await resumableSweep(run)).toEqual({
      sweepId: "T-sweep-5",
      dispatchedAt: "2026-09-06T00:05:00.000Z",
    });
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
    // and assuming both seats share one run would answer `2222` here.
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
      join: async () => ({ artifacts: [], blocked: [], claimedSuccess: [] }),
      collate: async () => ({ document: null, evidenceRef: "ref", staleCollators: [] }),
    };
    const driver = buildSweepDriver(run, briefing, process.env);
    expect(await driver.highestSweepNumber()).toBe(7);
    expect(await driver.inFlight()).toEqual({
      sweepId: "T-sweep-7",
      waitingOn: "T-sweep-7",
      dispatchedAt: null,
    });
    // §13 task 6.4a's member, wired to the SAME run — this parent has not
    // settled, so it is in flight and there is nothing to resume.
    expect(await driver.resumableSweep()).toBeNull();
    // Identity, not equality: a driver that rebuilt these would be a second
    // implementation of the four members that deliberately have none.
    expect(driver.openSweep).toBe(briefing.openSweep);
    expect(driver.dispatchObserver).toBe(briefing.dispatchObserver);
    expect(driver.join).toBe(briefing.join);
    expect(driver.collate).toBe(briefing.collate);
  });

  /**
   * **The wiring is pinned on a run tree where the answer is NOT `null`**, and
   * that is the whole point of a second test for one member. The case above
   * asserts `null`, which a driver wired to `async () => null` would also
   * satisfy — a fixture where the real read and a stub agree cannot tell them
   * apart, and §13 task 6.4a's member is exactly the kind that could ship
   * unwired while every pass-level test passed against a spy that supplied it.
   */
  test("resumableSweep is wired to the real run-tree read, not to a null stub", async () => {
    const run = await seedRun("2026-09-06T00-00-12Z-5454");
    await inboxTask(run, "T-sweep-7", "2026-09-06T00:00:00.000Z");
    await settle(run, "T-sweep-7");
    const driver = buildSweepDriver(
      run,
      {
        openSweep: async () => ({ kind: "opened" as const }),
        dispatchObserver: async () => {},
        join: async () => ({ artifacts: [], blocked: [], claimedSuccess: [] }),
        collate: async () => ({ document: null, evidenceRef: "ref", staleCollators: [] }),
      },
      process.env,
    );
    expect(await driver.resumableSweep()).toEqual({
      sweepId: "T-sweep-7",
      dispatchedAt: "2026-09-06T00:00:00.000Z",
    });
  });

  test("a sweep with no dispatch request projects an EMPTY partition rather than throwing", async () => {
    const run = await seedRun("2026-09-06T00-00-11Z-4444");
    const driver = buildSweepDriver(
      run,
      {
        openSweep: async () => ({ kind: "opened" as const }),
        dispatchObserver: async () => {},
        join: async () => ({ artifacts: [], blocked: [], claimedSuccess: [] }),
        collate: async () => ({ document: null, evidenceRef: "ref", staleCollators: [] }),
      },
      process.env,
    );
    expect(await driver.readPartition("T-sweep-1")).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Task 6.1a — the composition point, and the ONE argument it is still missing
// ---------------------------------------------------------------------------

describe("buildTriageSweepDriver: ten members from one dep set", () => {
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
   * **ALL TEN, by name.** §13 task 6.1a's whole subject is that four of them
   * were a refusing port; asserting the members by name rather than counting
   * them is what makes an eleventh — or a quietly dropped fourth — fail here, on
   * `monitor-readonly.test.ts:363-369`'s rule. The tenth, `resumableSweep`,
   * arrived with §13 task 6.4a and is listed here rather than counted for the
   * same reason: it is the member a driver could silently omit while every
   * behavioural test over the pass still passed against a spy that supplied it.
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
      "resumableSweep",
      "runs",
    ]);
    // Nine keys, ten members: `SweepDriver` counts `inFlight` and
    // `highestSweepNumber` separately from the seven below. Driven rather than
    // merely present, because a member assigned `undefined` also has a key.
    expect(await driver.openSweep("T-sweep-3", "2026-09-06T12:00:00.000Z")).toEqual({
      kind: "opened",
    });
    expect(await driver.join("T-sweep-3")).toEqual({ artifacts: [], blocked: [], claimedSuccess: [] });
    expect((await driver.collate("T-sweep-3")).document).toBeNull();
    expect(await driver.readPartition("T-sweep-3")).toEqual([]);
    expect(await driver.highestSweepNumber()).toBe(0);
    expect(await driver.inFlight()).toBeNull();
    expect(await driver.resumableSweep()).toBeNull();
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
 * THREE services, all in the one observer's slice (see `SLICE_OF` below),
 * because a partition is only exercised by a fixture it can be wrong about:
 * with one service, `checkTriagePartition` would be satisfied by a request
 * naming that single service, and a missing, duplicated or undeclared
 * service would never have a chance to show up.
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

/**
 * Each observer's partition — the division the COLLATOR chooses, spelled once.
 *
 * **WHOSE CHOICE THIS IS CHANGED ON 2026-09-13, and that is the whole of the
 * rework.** While there were two collators the host split the environment
 * between them — `evenSlices(3, 2)` is `[[routing, authorization],
 * [authentication]]` — and each collator was BRIEFED with its half, so a fixture
 * claiming a different division had its requests refused `partition_incomplete`
 * against the slice it was actually given. The division was not a free choice.
 *
 * With ONE collator it is. `evenSlices(3 services, 1 collator)` hands `tri-1`
 * the whole environment and `evenSlices(3 aspects, 1)` hands it all three seats,
 * so the partition among those seats is the collator's own judgement — §6.5's
 * ⌈N/3⌉, *"the partition is the triage worker's to make"*. The host checks only
 * that the union covers every declared service exactly once; it does not choose
 * the shares and does not refuse a lopsided one.
 *
 * So this table is now the FIXTURE COLLATOR's decision rather than a transcript
 * of the host's arithmetic, and one service each is the even split the role
 * prompt asks for. What still constrains it is the completeness check: drop a
 * service here and the sweep is refused `partition_incomplete`, name one twice
 * and it is refused `partition_duplicate`.
 */
const SLICE_OF: Readonly<Record<string, readonly string[]>> = {
  "obs-t1": ["routing"],
  "obs-t2": ["authorization"],
  "obs-t3": ["authentication"],
};

/**
 * Which observers each collator owns — the fan-out, spelled once.
 *
 * **`seats`, PLURAL, since 2026-09-13.** This was `seat: TRIAGE_CONSOLE_ASPECTS[i]`
 * — one aspect seat per collator, positional, exactly as `triage.ts` built it
 * while the console was two pairs. `SweepPair.seats` was always a LIST, which is
 * why one collator over three observers needed no re-architecture: the pairing
 * collapsed to a single entry holding every seat.
 *
 * **THIS FIXTURE ASSUMES ONE COLLATOR, and the assumption is asserted rather
 * than left to rot.** `expectDispatchesWereWellFormed` derives its dispatch
 * count from `p.seats.length` per pair, so a second collator would not silently
 * produce wrong expectations — but the flat `seats: TRIAGE_CONSOLE_ASPECTS`
 * below WOULD hand both collators all three seats, which is not what
 * `evenSlices` would do. If `TRIAGE_CONSOLE_ROSTER.collators` ever grows, this
 * line has to share the aspects out rather than copy them.
 */
const PAIRS = TRIAGE_CONSOLE_ROSTER.collators.map((collator) => ({
  collator,
  seats: TRIAGE_CONSOLE_ASPECTS,
}));

const isCollator = (worker: string): boolean =>
  TRIAGE_CONSOLE_ROSTER.collators.includes(worker);

/** The pair a collator acts for. */
const pairOf = (collator: string): (typeof PAIRS)[number] =>
  PAIRS.find((p) => p.collator === collator)!;

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
 *
 * **IT ASSERTS NOTHING — §13 task 6.9a.** `triageActorLoop` catches everything
 * `deps.pass()` throws into `pass_failed`, correctly and by §6.4, so an
 * `expect(...)` in here is a real assertion under `--once` and a DISCARDED one
 * under every `--poll` test in this file: a test could assert a settle deadline,
 * be wrong about it, and pass. Every claim this fixture used to make from inside
 * itself is now a RECORDED value, re-made outside the swallow by
 * {@link expectDispatchesWereWellFormed}. What makes that a fix rather than a
 * relocation is that the recorded arrays are asserted by LENGTH out there: a
 * throw from in here — including a deliberately wrong expectation somebody adds
 * back — truncates the sequence and reddens the test that used to swallow it.
 */
function fixtureFleetDispatch(
  run: RunPaths,
  log: string[],
  windows: (string | null)[],
  titles: string[],
  settled: string[],
): SweepDispatch {
  let sweepId = "";
  return async ({ taskId, worker, title, brief }) => {
    titles.push(title);
    log.push(`${worker}:${taskId}`);
    await writeJson(inboxTaskPath(run, taskId), { schema: "pifleet.task/v1", task_id: taskId });

    if (isCollator(worker) && !taskId.endsWith("-collate")) {
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
      // RECORDED, never asserted here: a `null` reaches the observer artifacts
      // below as a missing `window_opened_at` — which §7.4's freshness gate
      // refuses, so the pass changes shape too — and the claim itself is made
      // outside the loop's swallow.
      windows.push(window?.[1] ?? null);
      /*
       * INTO THE ACTING COLLATOR'S OWN OUTBOX, naming EVERY SEAT IT OWNS.
       *
       * ONE entry per observer inside ONE `requests[]` file, the union covering
       * every declared service exactly once — which is what `roles/triage.md`
       * now asks the collator for, and what §6.5 always specified.
       *
       * **This has been all three shapes, and the middle one is the instructive
       * failure.** It wrote one request covering every aspect (one collator, all
       * observers); then one request naming only its own seat, because two
       * collators each briefed their own observer and `readSweepPartition` reads
       * both outboxes and CONCATENATES — a fixture that kept writing the whole
       * partition from one sender would have produced a duplicate claim on every
       * service the moment the second collator wrote, and the sweep would be
       * refused `partition_duplicate`. With one collator the concatenation has a
       * single contributor again, so the fan-out returns to this file.
       */
      const { seats } = pairOf(worker);
      await writeJson(dispatchRequestPath(run.root, worker, taskId), {
        schema: DISPATCH_REQUEST_SCHEMA,
        parent_task_id: taskId,
        requests: seats.map((seat) => ({
          worker: seat.worker,
          title: `${taskId} ${seat.worker}`,
          brief: `Observe ${SLICE_OF[seat.worker]!.join(", ")} and report one row per service.`,
          services: [...SLICE_OF[seat.worker]!],
        })),
      });
    } else if (!isCollator(worker)) {
      /*
       * An observer's turn — §7.4's artifact, echoing both host-minted values.
       *
       * Written into the SEAT's own run, not the collator's, because that is
       * where a real observer writes and where the join now reads (D4: a console
       * is four runs). This fixture wrote to `run` until 2026-09-07 and passed,
       * which is exactly how the production join came to read a path that could
       * not exist: with both halves using the collator's tree the mistake is
       * invisible, and only a seat that has MOVED — the recycle test below —
       * tells them apart.
       */
      const seatRuns = await resolveSeatRuns(undefined, process.env);
      const seatId = seatRuns[worker];
      const seatTree =
        seatId === undefined ? run : runPaths(seatId, runsRoot(process.env));
      await writeJson(observerArtifactPath(seatTree, worker, taskId), {
        sweep_id: sweepId,
        window_opened_at: windows[windows.length - 1],
        status: "success",
        services: SLICE_OF[worker]!.map((service) => ({
          service,
          assessment: documentRow(service, worker)["assessment"],
        })),
      });
    } else {
      // Turn two — §7.5's collation document.
      /*
       * ONE DOCUMENT PER COLLATOR, carrying the rows of every seat it owns,
       * written into its own outbox — `triageDocumentPath`'s third argument.
       *
       * With one collator this is the whole environment again, and the ROW
       * ATTRIBUTION is what now carries the split: each row is stamped with the
       * seat that observed it (`documentRow`'s second argument), so a wiring
       * that collated one observer's rows three times, or lost a seat's rows
       * entirely, is visible here even though the service list is complete
       * either way. While there were two collators the split was visible as two
       * half-documents; it has moved inside the one document rather than gone.
       */
      const { seats } = pairOf(worker);
      await writeJson(triageDocumentPath(run, taskId, worker), {
        schema: TRIAGE_DOCUMENT_SCHEMA,
        sweep_id: sweepId,
        services: seats.flatMap((s) =>
          SLICE_OF[s.worker]!.map((service) => documentRow(service, s.worker)),
        ),
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
    /*
     * THE LAST STATEMENT, and it is what makes the swallow OBSERVABLE rather
     * than merely avoided (§13 task 6.9a).
     *
     * `log` above records that this stub was ENTERED; this records that it ran
     * to the end. `triageActorLoop` catches everything the pass throws, so a
     * throw from anywhere in here — a deliberately wrong `expect` on the very
     * last line included — is invisible to the loop's own exit value and to a
     * `dispatched` array that was already full. It is not invisible to a
     * comparison of the two: `expectDispatchesWereWellFormed` asserts they are
     * EQUAL, so entered-but-did-not-finish is a red test.
     *
     * MEASURED, not assumed. Before this line, a wrong expectation placed on
     * the last line of this stub survived `--poll takes §7.7's lock`'s free
     * half — five dispatches recorded, `{ kind: "stopped", passes: 1 }`
     * returned, nothing asserting the pass had SUCCEEDED. That is the exact
     * failure §13 task 6.9a names, and it is the one the first draft of this
     * fix still let through.
     */
    settled.push(`${worker}:${taskId}`);
    return { kind: "accepted" };
  };
}

interface FixtureFleet {
  readonly run: RunPaths;
  readonly effects: TriageProductionEffects;
  /** `worker:taskId`, in dispatch order. */
  readonly dispatched: string[];
  readonly delivered: NotifyRequest[];
  /** `down <runId>` / `up <seat>`, in the order the recycle asked for them. */
  readonly recycled: string[];
  /**
   * Every `settleDeadlineMs` the console handed the root's dispatch factory, in
   * order — RECORDED rather than asserted inside `dispatchFor`.
   *
   * `triageActorLoop` catches everything `deps.pass()` throws into
   * `pass_failed`, an `expect` inside the fixture's dispatch included. So an
   * in-fixture assertion is a real assertion under `--once` and a SWALLOWED one
   * under `--poll`, and §13 task 6.9's deadline claim is a `--poll` claim.
   */
  readonly deadlines: number[];
  /**
   * Every dispatch TITLE the console minted, in order (§13 task 6.9a).
   *
   * `title.length > 0` used to be an `expect` inside the dispatch stub. It is a
   * real claim — `renderSweepEnvelope` builds the title and a worker's inbox
   * record with an empty one is a task nobody can name — and it was discarded on
   * every `--poll` path in this file.
   */
  readonly titles: string[];
  /**
   * The observation window the HOST minted, read back out of each sweep brief —
   * one per sweep, and `null` when the brief carried none (§13 task 6.9a).
   *
   * §7.2 tells the collator to copy the instant *"from here and from nowhere
   * else"*, so a fixture that invented its own would satisfy §7.4's freshness
   * gate by coincidence. The absence is recorded rather than thrown for the same
   * reason as the titles: a throw here is swallowed and a `null` out there is not.
   */
  readonly windows: (string | null)[];
  /**
   * The same `worker:taskId` entries as {@link dispatched}, pushed by the LAST
   * statement of the dispatch stub instead of its first (§13 task 6.9a).
   *
   * `dispatched` says the stub was entered; this says it finished. The loop
   * swallows what the pass throws, so the two disagreeing is the only evidence
   * that an assertion inside the stub failed — and it is evidence that survives
   * a stub which had already recorded everything before it threw.
   */
  readonly settled: string[];
  /**
   * What every entry of {@link deadlines} must equal — §7.8's
   * `(cadence_s − reserve_s) × 1000`, fixed by the fixture's own options rather
   * than read back out of the thing under test.
   */
  readonly settleDeadlineMs: number;
  /** How many times the saturation probe was reached. MUST stay 0. */
  readonly probes: { count: number };
}

/**
 * What a fixture may vary about the console it builds. Everything here defaults
 * to the shape the tests written before §13 tasks 6.5c and 6.9 assumed, so the
 * two options are additive rather than a rewrite of nine call sites.
 */
interface FixtureFleetOptions {
  /**
   * Which seats the run materialises. The default is both of the console's
   * current seats — {@link TRIAGE_COLLATOR} plus its one observer; a list
   * WITHOUT {@link TRIAGE_COLLATOR} is the cold console task 6.5c is about,
   * and it has to be built by omission rather than by deleting a directory
   * afterwards — see the note on `seats` below.
   */
  readonly seats?: readonly string[];
  /**
   * `triage/console.yaml`'s body. **Absent means the file is NOT WRITTEN**,
   * which is not the same as writing an empty one and is the state every test
   * before task 6.9 ran in: `loadTriageConsoleConfig` turns a missing file into
   * the empty string and `parseTriageConsoleConfig`'s empty-document arm is the
   * only place §7.8's defaults are produced.
   */
  readonly console?: string;
  /**
   * What `dispatchFor` must be handed, in ms. §7.8 computes it as
   * `(cadence_s − reserve_s) × 1000`, so a fixture that moves `cadence_s` moves
   * this with it — and the assertion stays an assertion rather than becoming a
   * value the fixture reads back out of the thing it is testing.
   */
  readonly settleDeadlineMs?: number;
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
async function fixtureFleet(
  runId: string,
  fixture: FixtureFleetOptions = {},
): Promise<FixtureFleet> {
  const base = process.env["HOME"]!;
  const run = runPaths(runId, process.env["PIFLEET_RUNS_DIR"]!);
  await mkdir(run.inboxDir, { recursive: true });
  await writeFile(join(run.root, "run.json"), JSON.stringify({ run_id: runId }));
  // The collator's directory is what `resolveCollatorRun` scans for.
  for (const w of fixture.seats ??
    [...TRIAGE_CONSOLE_ROSTER.collators, ...TRIAGE_CONSOLE_ASPECTS.map((s) => s.worker)]) {
    await mkdir(join(run.workersDir, w), { recursive: true });
  }

  const configDir = join(base, "fleet");
  await mkdir(join(configDir, "triage"), { recursive: true });
  await writeFile(join(configDir, "triage", "targets.yaml"), FIXTURE_TARGETS);
  if (fixture.console !== undefined) {
    await writeFile(join(configDir, "triage", "console.yaml"), fixture.console);
  }
  const kubeconfig = join(configDir, "kubeconfig.yaml");
  await writeFile(kubeconfig, FIXTURE_KUBECONFIG);

  const dispatched: string[] = [];
  const delivered: NotifyRequest[] = [];
  const windows: (string | null)[] = [];
  const titles: string[] = [];
  const settled: string[] = [];
  const recycled: string[] = [];
  const deadlines: number[] = [];
  const published: Array<{ taskId: string; children: string[] }> = [];
  const probes = { count: 0 };

  const effects: TriageProductionEffects = {
    dispatchFor: (r, opts) => {
      /*
       * §7.8's `sweep_deadline_s` — `cadence_s − reserve_s` — reaches the effect
       * as a bound, which is the half of the split task 6.1b decided: the
       * deadline is the console's decision, the dispatch is the root's
       * capability.
       *
       * RECORDED AND NOT ASSERTED (§13 task 6.9a). This factory is called from
       * inside `deps.pass()`, so an `expect` here is discarded by the loop's
       * catch on every `--poll` path — which is how a test could assert this
       * deadline, be wrong about it, and pass.
       */
      deadlines.push(opts.settleDeadlineMs);
      return fixtureFleetDispatch(r, dispatched, windows, titles, settled);
    },
    /*
     * §6.3 step 7's publish-and-declare, recorded so a test can assert the
     * collator was actually handed each child's reply. The real one writes into
     * the collator's `:ro` /replies mount AND rewrites its `/policy/replies`
     * declaration in one act (SRD-WORKER-DISPATCH-EXTENSION §7.4); here it is a
     * list, because what the console owns is WHETHER it publishes, under which
     * task, and for which children.
     */
    publishRepliesFor: () => async (taskId, replies) => {
      published.push({ taskId, children: replies.map((r) => r.task_id) });
    },
    isCollatorLive: async () => true,
    /*
     * §13 task 6.5b's two privileged effects, RECORDED and never performed. The
     * production pair drives `pifleet down --run` and `pifleet up --workers`;
     * a fixture that reached them would recycle a real worker, which the
     * round's own rule forbids and which no unit test could undo.
     */
    downRun: async (runId) => {
      recycled.push(`down ${runId}`);
    },
    upSeat: async (seat) => {
      recycled.push(`up ${seat}`);
    },
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

  return {
    run,
    effects,
    dispatched,
    delivered,
    recycled,
    deadlines,
    titles,
    windows,
    settled,
    settleDeadlineMs: fixture.settleDeadlineMs ?? 240_000,
    probes,
  };
}

/**
 * **Every claim the dispatch fixture makes about a dispatch, made OUT HERE —
 * §13 task 6.9a.**
 *
 * ## The defect this replaces
 *
 * `triageActorLoop` catches everything `deps.pass()` throws and turns it into a
 * `pass_failed` log line, which is right: §6.4 decides that *"an actor that dies
 * on one bad sweep stops watching"*. The consequence is that an `expect(...)`
 * inside a stub the pass reaches is a REAL assertion under `--once` and a
 * DISCARDED one under `--poll`. Three lived in this file's fixture — the settle
 * deadline, the dispatch title, the observation window — and every `--poll` test
 * here ran them for nothing. A test could assert a deadline, be wrong about it,
 * and pass.
 *
 * ## Why this is a fix and not a relocation
 *
 * Moving an assertion out only helps if the recorded evidence is COMPLETE, and
 * that is what {@link FixtureFleet.dispatched}'s length is for: a throw from
 * inside any stub — a deliberately wrong expectation somebody adds back
 * included — ends the pass early, truncates every recorded array, and reddens
 * this function. So the swallow is not merely avoided, it is OBSERVED. That is
 * the anti-criterion §13 names, and it is measured rather than argued: the
 * mutation battery for this round put `expect(1).toBe(2)` inside `dispatchFor`
 * and every `--poll` test that reaches a real sweep went red.
 *
 * `sweeps` is how many passes reached the dispatch factory — 0 for a test whose
 * pass is a stub, which is a claim rather than an exemption: it says the stub
 * really did dispatch nothing.
 */
function expectDispatchesWereWellFormed(
  fleet: FixtureFleet,
  expected: { readonly sweeps: number },
): void {
  const { sweeps } = expected;
  // THE COMPLETENESS CLAIM, and the one that makes every line below meaningful:
  // FIVE dispatches per sweep since 2026-09-13 — one collator's sweep envelope,
  // its three observers' slices, and its collation. It was three at one pair and
  // six at two, and the comment that stood here predicted this exact figure
  // ("five when one collator fanned out to three observers") a day before it
  // became true.
  //
  // DERIVED PER PAIR rather than spelled, because every fixed expression tried
  // here has been wrong within a day of being written. `PAIRS.length * 3` was
  // right at two pairs of one seat each and is wrong the moment a pair holds a
  // different number of seats; `2 + TRIAGE_CONSOLE_ASPECTS.length` coincided with
  // the right answer at one pair and evaluated to four at two. Each pair
  // contributes its open, its collation, and one dispatch per seat it owns —
  // which is the actual rule and is true at every shape this console has had.
  const perSweep = PAIRS.reduce((n, p) => n + 2 + p.seats.length, 0);
  expect(fleet.dispatched.length, "the recorded dispatch sequence is short — a stub threw").toBe(
    perSweep * sweeps,
  );
  // ENTERED equals FINISHED. This is the arm that catches a throw from the LAST
  // line of the stub, where everything has already been recorded and only the
  // pass's own success is missing — measured, because the first draft of this
  // helper let exactly that through.
  //
  // **Compared as a MULTISET, since the fan-out became concurrent (2026-09-07).**
  // The claim here is completeness — every dispatch that was entered also
  // finished — and it never was a claim about order; the two arrays agreed
  // element-for-element only because a serial loop made finishing order and entry
  // order the same thing by accident. Three observers dispatched concurrently may
  // settle in any order, and asserting the raw sequence would fail on a schedule
  // rather than on a defect. Sorting keeps every failure this was built to catch —
  // a missing entry, a duplicate, an extra — and drops only the coincidence.
  expect(
    [...fleet.settled].sort(),
    "a dispatch stub was entered and did not finish — it threw",
  ).toEqual([...fleet.dispatched].sort());
  // One factory call per pass that reached the driver, each carrying §7.8's
  // deadline. `toEqual` on the whole array, so a second pass at a different
  // deadline cannot hide behind a `toContain`.
  expect(fleet.deadlines).toEqual(Array.from({ length: sweeps }, () => fleet.settleDeadlineMs));
  // A title per dispatch, none of them empty.
  expect(fleet.titles.length).toBe(fleet.dispatched.length);
  expect(fleet.titles.filter((t) => t.trim() === "")).toEqual([]);
  // One host-minted observation window per COLLATOR per sweep, none missing.
  // Each pair is opened with its own envelope and each envelope states its own
  // instant. **Back to one per sweep, and still spelled `* PAIRS.length`**: this
  // read a bare `sweeps` while the console had one collator, went wrong when it
  // grew to two, and is numerically identical again now that it is back to one.
  // The factor stays because it is the REASON rather than the current value —
  // the number of windows is a fact about collators, not about sweeps.
  expect(fleet.windows.length).toBe(sweeps * PAIRS.length);
  expect(fleet.windows.filter((w) => w === null)).toEqual([]);
  // §12's closing anti-criterion: no criterion in this file requires a real
  // model. The fixture's probe THROWS, and a throw inside the pass is exactly
  // what the loop swallows — so the count is asserted rather than the throw.
  expect(fleet.probes.count).toBe(0);
  /*
   * AND NO PASS FAILED, wherever a loop actually ran.
   *
   * `settled` above catches a throw from anywhere inside the dispatch stub up
   * to its completion marker. This catches the whole of the rest of the
   * surface — `dispatchFor` itself, a stub the BOUNDARY reaches, and an
   * assertion somebody adds AFTER that marker — because `triageActorLoop`
   * writes a `pass_failed` line for every throw it swallows. §9.15 makes that
   * log the actor's guaranteed surface, so this reads the one channel a
   * swallowed throw cannot avoid.
   *
   * Conditional on the log existing, and the condition is EXACT rather than
   * convenient: only the loop writes one, and `--once` needs no guard here
   * because §6.4 has it propagate the throw to the caller — where every
   * `--once` test above already asserts `err` is null.
   */
  const actorLog = triageActorLogPath(fleet.effects.env);
  if (existsSync(actorLog)) {
    expect(
      readFileSync(actorLog, "utf8"),
      "the loop swallowed a thrown pass — something inside a fixture stub failed",
    ).not.toContain("pass_failed");
  }
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
  test("dispatches the sweep, then every observer, then the collation", async () => {
    const fleet = await fixtureFleet("2026-09-06T01-00-00Z-1111");
    const deps = productionTriageDeps(async () => fleet.effects);
    const { err, out } = await runTriage(["--once"], deps);

    expect(err).toBeNull();
    /*
     * **The ordering that is real, and the ordering that was a coincidence.**
     *
     * §6.3's sequence is a claim about three PHASES: the parent envelope goes
     * first because the partition does not exist until the collator writes it, and
     * the collation goes last because it names the children. Those two are causal
     * and are asserted exactly, by position.
     *
     * Whatever observers sit between them are NOT ordered by anything. They are
     * dispatched concurrently (§6.5 — a slice is independent of every other slice
     * by construction), so their entry order is a scheduling detail. Asserting it
     * would fail on a schedule rather than on a defect — which is exactly what
     * pinning it did back when this console still ran three observers: it made
     * the fan-out serial and cost this console two of three observers on its
     * first live sweep.
     */
    const seatsOf = PAIRS.flatMap((p) => p.seats);
    expect(fleet.dispatched).toHaveLength(2 * PAIRS.length + seatsOf.length);
    /*
     * THE OPENS FIRST, in pair order. `openSweep` loops the pairs sequentially
     * and deliberately — a budget refusal on the first must STOP the second
     * rather than race it — so this order is a fact rather than a schedule.
     */
    expect(fleet.dispatched.slice(0, PAIRS.length)).toEqual(
      PAIRS.map((p) => `${p.collator}:T-sweep-1`),
    );
    /* THE COLLATIONS LAST, one per pair. Sorted: nothing orders the pairs here. */
    expect([...fleet.dispatched.slice(-PAIRS.length)].sort()).toEqual(
      PAIRS.map((p) => `${p.collator}:T-sweep-1-collate`).sort(),
    );
    /*
     * AND THE FAN-OUT IN THE MIDDLE — asserted by WHICH SEATS, never by order
     * and never by task-id spelling. This is the coverage the note below records
     * as dropped in 2026-09-07: a partition reaching several seats in one sweep
     * is checkable again, so a fan-out that dropped or duplicated a slice across
     * observers now fails here.
     */
    expect(
      fleet.dispatched
        .slice(PAIRS.length, PAIRS.length + seatsOf.length)
        .map((d) => d.slice(0, d.indexOf(":")))
        .sort(),
    ).toEqual(seatsOf.map((s) => s.worker).sort());
    /*
     * COVERAGE RESTORED 2026-09-12, on the instruction the 2026-09-07 note left
     * here: *"Restore this to a set assertion if the console regains a second
     * seat."* It regained one as a second PAIR, and the set assertion is the
     * fan-out check above — a partition that dropped or duplicated a slice
     * across observers fails there now, which is the property that note
     * recorded as unguarded.
     *
     * The line that stood here read `dispatched.slice(1, 2)` and expected the
     * single observer's slice. Index 1 is now the SECOND COLLATOR's open, so it
     * was not merely narrow — it was asserting against the wrong entry, and
     * would have gone on passing only while the console had exactly one pair.
     */
    // OBSERVERS, not pairs — the two were the same number while each collator
    // owned exactly one seat, and this line rode that coincidence. One collator
    // over three observers separates them: the sweep reports THREE.
    expect(out).toContain(`T-sweep-1: swept ${seatsOf.length} observers`);
    // Deadline, titles, window and §12's closing anti-criterion, all out here.
    expectDispatchesWereWellFormed(fleet, { sweeps: 1 });
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
    // ALL THREE observers, sorted: the fan-out is concurrent by construction
    // (§6.5 — a slice is independent of every other slice), so the order these
    // settle in is a schedule rather than a fact worth asserting. Sorting was
    // already the right call when there were two; at three it is what keeps this
    // from failing on a scheduler rather than on a defect.
    expect([...outcome.dispatched].sort()).toEqual(["obs-t1", "obs-t2", "obs-t3"]);
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
    expectDispatchesWereWellFormed(fleet, { sweeps: 1 });
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
    // TWO sweeps' worth, which is also how this test knows the second pass was
    // a second sweep rather than the first one counted twice.
    expectDispatchesWereWellFormed(fleet, { sweeps: 2 });
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
    const stop = new AbortController();
    /*
     * Bounded by the WATCH rather than by the pass — see `boundedByTheWatch`.
     * Since §13 task 6.5b wired the ports, §6.6's gate can withhold the sweep,
     * so a stop that only fires inside the pass is no longer a stop at all: the
     * loop would spin past this test and into the next file.
     */
    const deps = productionTriageDeps(async () => boundedByTheWatch(fleet.effects, stop));

    const started = Date.now();
    const exit = await deps.loop(async () => await deps.pass(), {
      cadenceS: 1,
      signal: stop.signal,
    });
    expect(exit).toEqual({ kind: "stopped", passes: 1 });
    // One cadence, not two: a loop that ignored the signal would sit here.
    expect(Date.now() - started).toBeLessThan(10_000);
    /*
     * The sweep really happened through the loop, not only through `--once` —
     * and every claim the dispatch fixture makes is checked HERE, because this
     * is a `--poll` test and the loop discards what its stubs throw (§13 task
     * 6.9a). Before that fix this test ran three assertions for nothing.
     */
    expectDispatchesWereWellFormed(fleet, { sweeps: 1 });

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
   * **§13 TASK 6.7a's ACCEPTANCE: `--status` REPORTS A HEALTHY ACTOR FROM ITS
   * FIRST PASS.**
   *
   * The re-point of `scripts/triage`'s `triageActorArgv` from `pifleet relay
   * --console triage` to `pifleet triage` moved three things, and this is the
   * second: the script used to write the actor's record itself, through
   * `writeRelayRecord`, whose schema is a **non-strict `z.object` and therefore
   * STRIPS unknown keys**. §7.7's `TriageActorRecordSchema` requires `cadence_s`
   * and gives it no default, so a record written that way parses as
   * `{ kind: "refused" }` — and `--status` would report `actor: refused` for a
   * perfectly healthy actor until its first `saveCursor` overwrote the file.
   * Adding `cadence_s` to the literal does not help; the schema removes it on
   * the way to disk.
   *
   * So the script writes NOTHING and the actor is its own record's only writer.
   * The consequence is a state worth asserting in both directions, which is what
   * this test does:
   *
   *   - **before** the first pass there is no record and `--status` says
   *     `absent` — not `refused`, and not `0` sweeps. That is the honest answer
   *     and it is a DIFFERENT one from the defect's;
   *   - **after** it, every field §7.7 carries is the running actor's own: the
   *     pid, the cadence it is actually ticking at, and the sweep it completed.
   *
   * The premise arm is what makes this more than a re-run of the record test
   * above: without it, an implementation that wrote a healthy record at startup
   * — which is where a fourth blocker would hide, because that write happens
   * BEFORE §6.3b's lock and would let a refused actor clobber a live one's
   * record — passes the second half and fails the first.
   *
   * `cadenceS: 1` for `boundedByTheWatch`'s reason, and the number is asserted:
   * a record that said 300 would be one written by something other than this
   * actor.
   */
  test("--status reports absent before the first pass and a healthy actor after it", async () => {
    const fleet = await fixtureFleet("2026-09-06T01-00-07Z-8888");
    const env = fleet.effects.env;

    // THE PREMISE: nothing wrote §7.7's record — not the script, not the actor.
    const before = await triageStatus(env, censusOver(new Map()));
    expect(before.actor, "something wrote the actor's record before the actor did").toBe("absent");
    expect(before.actor_reason).toBeNull();
    expect(before.sweeps_completed).toBeNull();

    const stop = new AbortController();
    const deps = productionTriageDeps(async () => boundedByTheWatch(fleet.effects, stop));
    const exit = await deps.loop(async () => await deps.pass(), {
      cadenceS: 1,
      signal: stop.signal,
    });
    expect(exit).toEqual({ kind: "stopped", passes: 1 });

    // THE POINT: one pass, and the record parses as §7.7's — `present`, never
    // the `refused` a stripped `cadence_s` produces.
    const after = await triageStatus(env, censusOver(new Map()));
    expect(after.actor).toBe("present");
    expect(after.actor_reason).toBeNull();
    expect(after.pid).toBe(process.pid);
    expect(after.cadence_s).toBe(1);
    expect(after.sweeps_completed).toBe(1);
    // And the sweep it counted really happened.
    expectDispatchesWereWellFormed(fleet, { sweeps: 1 });
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
    expect([...doc.dispatched].sort()).toEqual(["obs-t1", "obs-t2", "obs-t3"]);
    expectDispatchesWereWellFormed(fleet, { sweeps: 1 });
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
    // ONE sweep across both halves: the premise swept, the orphaned run refused
    // before the driver was built, and the two share these recorded arrays.
    expectDispatchesWereWellFormed(present, { sweeps: 1 });
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
    // `run.json` is not decoration: `runIdsAscending` skips any directory
    // without one, so a bare `mkdir` is invisible to the scan and this fixture
    // would not contain a newer run at all.
    await writeFile(join(newer.root, "run.json"), JSON.stringify({ run_id: newer.runId }));

    // THE PREMISE, asserted a step earlier and the reason this test is worth
    // anything. Without it the fixture passed for the wrong reason: the newer
    // run was skipped by the scan BOTH implementations use, so a mutant that
    // took the newest run outright survived — reachable, compiled, and
    // indistinguishable, because the candidate it would have wrongly picked was
    // never a candidate. Measured 2026-09-07; the mutant dies now.
    const candidates = await runIdsAscending(process.env["PIFLEET_RUNS_DIR"]!);
    expect(candidates).toContain(newer.runId);
    expect(candidates[candidates.length - 1]).toBe(newer.runId);

    expect((await resolveCollatorRun(process.env)).runId).toBe(older.run.runId);
    // Nothing swept here, and that is a claim rather than an omission.
    expectDispatchesWereWellFormed(older, { sweeps: 0 });
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
    expectDispatchesWereWellFormed(fleet, { sweeps: 0 });
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
    /*
     * THE COLLATOR'S WHOLE ENVIRONMENT, and the SPLIT asserted where it now
     * lives — between the SEATS inside one document.
     *
     * **This test has been re-aimed twice and the second move is not a
     * narrowing.** It expected all three services while one collator covered the
     * environment; then each collator's own half separately, because two
     * collators each collated only the slice they were briefed with. With one
     * collator the environment is whole again, so a naive restoration of the
     * first version would pass — and would assert nothing about the fan-out,
     * which is the property that actually changed.
     *
     * So the union is asserted against the SEATS' slices rather than against the
     * targets file: a wiring that collated one observer's rows three times, or
     * dropped a seat's rows entirely, produces a service list that is wrong here
     * even though the collator "reported the whole environment" either way. The
     * length check is the duplicate arm — three services, three rows, so a
     * double-collation reddens rather than hiding inside a `sort()`.
     */
    const seats = PAIRS[0]!.seats;
    expect(doc?.services.map((s) => s.service).sort()).toEqual(
      seats.flatMap((s) => [...SLICE_OF[s.worker]!]).sort(),
    );
    expect(doc?.services).toHaveLength(seats.reduce((n, s) => n + SLICE_OF[s.worker]!.length, 0));
    expectDispatchesWereWellFormed(fleet, { sweeps: 1 });
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
    expectDispatchesWereWellFormed(fleet, { sweeps: 1 });
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

// ---------------------------------------------------------------------------
// §13 task 6.5b — the ports at the composition root: the lock, and the recycle
// ---------------------------------------------------------------------------

/** Every seat this console has, spelled from the roster rather than typed. */
const ALL_SEATS = [
  ...TRIAGE_CONSOLE_ROSTER.collators,
  ...TRIAGE_CONSOLE_ASPECTS.map((s) => s.worker),
];

/**
 * Effects whose loop is BOUNDED BY THE WATCH, not by the pass — and the reason
 * is a measured one rather than a preference.
 *
 * The obvious way to stop a production `--poll` in a test is to abort inside the
 * pass it was handed. That bound is not a bound: **the pass does not run on every
 * iteration.** §6.6's gate withholds the sweep whenever a seat's pin is
 * unresolved, so any defect that leaves a pin unresolved — and a mutation that
 * empties `seatRuns` is exactly that — makes the loop spin forever at the test's
 * one-second cadence, with `bun test`'s per-test timeout failing the test while
 * the loop's promise keeps running into the NEXT test file. It was measured
 * during this task's mutation battery, and the tell was a run directory created
 * under the real `~/.pifleet` after `afterAll` had put `PIFLEET_RUNS_DIR` back.
 *
 * `isCollatorLive` is the member that cannot be skipped: `triageActorLoop`
 * observes liveness whether the pass ran, threw, or was withheld (§6.4's *"the
 * observation happens whether the pass threw or not"*). So the bound lives there,
 * which is `triage-actor.test.ts`'s own `harness` rule — *"a loop harness whose
 * every exit is BOUNDED"* — applied to the production wiring.
 */
function boundedByTheWatch(
  effects: TriageProductionEffects,
  stop: AbortController,
  opts: { readonly maxObservations?: number; readonly onObserve?: (run: RunPaths) => void } = {},
): TriageProductionEffects {
  const max = opts.maxObservations ?? 1;
  let observations = 0;
  return {
    ...effects,
    isCollatorLive: async (run) => {
      observations += 1;
      opts.onObserve?.(run);
      if (observations >= max) stop.abort();
      return true;
    },
  };
}

/**
 * The bound for a loop whose cadence is a REAL one, and it is the only bound
 * that costs no wall clock (§13 task 6.9).
 *
 * `boundedByTheWatch` stops the loop by aborting the signal inside the
 * observation — and `runTriageActor` checks `isStopped` *after* `deps.sleep`, so
 * that bound always pays one full cadence. At `cadenceS: 1` that is a second and
 * nobody notices. **Task 6.9's whole subject is a cadence that comes from
 * `triage/console.yaml`, and `TriageConsoleConfigSchema` floors `cadence_s` at
 * 60** — so no file a fixture can legally write makes the post-sleep bound
 * affordable, and the production `sleep` is the shipped `setTimeout` rather than
 * an injected one (deliberately: `productionLoop`'s docblock).
 *
 * So this bound exits BEFORE the sleep instead. `triageActorLoop`'s only
 * pre-sleep return is `console_gone`, reached when `ConsoleWatch` runs out of
 * tolerance — which is why these tests pass `tolerance: 1` and this helper
 * answers the watch with a NEGATIVE. One observation, one abandonment, no timer,
 * and the record under assertion is written before either (the actor saves the
 * cursor, then observes).
 *
 * Rule 4 of this round is what makes the distinction worth a helper: a loop that
 * outlives its test keeps running into the NEXT file, by which point `afterAll`
 * has put `PIFLEET_RUNS_DIR` back and the writes land in the operator's own
 * `~/.pifleet`.
 */
function boundedBeforeTheSleep(
  effects: TriageProductionEffects,
  observations: { count: number },
): TriageProductionEffects {
  return {
    ...effects,
    isCollatorLive: async () => {
      observations.count += 1;
      return false;
    },
  };
}

/**
 * A run tree holding exactly the seats named, so a test can state a console's
 * shape by listing it.
 *
 * `run.json` is what the run walk expects and `workers/<id>/` is what
 * `resolveSeatRuns` looks for, so a seat is pinned iff its directory is there.
 */
async function runHolding(runId: string, seats: readonly string[]): Promise<RunPaths> {
  const run = runPaths(runId, process.env["PIFLEET_RUNS_DIR"]!);
  await mkdir(run.inboxDir, { recursive: true });
  await writeFile(join(run.root, "run.json"), JSON.stringify({ run_id: runId }));
  for (const seat of seats) await mkdir(join(run.workersDir, seat), { recursive: true });
  return run;
}

describe("§13 task 6.5b: --poll takes §7.7's lock (§6.3b)", () => {
  /**
   * **The lock is the half of task 6.3b that only a call site can land**, and
   * this is that call site driven end to end: `productionTriageDeps().loop`
   * builds `TriageConsolePorts.acquireLock` out of the real
   * {@link acquireTriageActorLock}, so a second actor meets the first one's file.
   *
   * Both directions in one test, because each is meaningless alone: an assertion
   * that a held lock refuses passes against an actor that refuses always, and an
   * assertion that a free lock sweeps passes against an actor that has no lock at
   * all. The refusal NAMES the file (§6.3b — *"the only thing an operator can do
   * about it is look at that file"*) and it dispatches NOTHING, which is the
   * property §6.4's *"two concurrent sweeps against one control plane"* is about.
   */
  test("a held lock refuses BY NAME and sweeps nothing; a free one sweeps and gives it back", async () => {
    const fleet = await fixtureFleet("2026-09-06T02-00-00Z-1001");
    const env = fleet.effects.env;
    await mkdir(dirname(triageActorLockPath(env)), { recursive: true });

    const held = await acquireTriageActorLock(env);
    expect(held, "the fixture could not take the lock it is about to contend for").not.toBeNull();
    try {
      const stopBlocked = new AbortController();
      const blocked = productionTriageDeps(async () =>
        boundedByTheWatch(fleet.effects, stopBlocked),
      );
      const exit = await blocked.loop(async () => await blocked.pass(), {
        cadenceS: 1,
        signal: stopBlocked.signal,
      });
      expect(exit.kind).toBe("refused");
      expect(exit.kind === "refused" && exit.reason).toContain(triageActorLockPath(env));
      // `passes: 0` and an empty dispatch log are the same fact from two sides.
      expect(exit.kind === "refused" && exit.passes).toBe(0);
      expect(fleet.dispatched).toEqual([]);
    } finally {
      await held!.release();
    }

    const stop = new AbortController();
    const free = productionTriageDeps(async () => boundedByTheWatch(fleet.effects, stop));
    const exit = await free.loop(async () => await free.pass(), {
      cadenceS: 1,
      signal: stop.signal,
    });
    expect(exit).toEqual({ kind: "stopped", passes: 1 });
    // ONE sweep across both halves: the blocked actor dispatched nothing, so
    // every recorded array here belongs to the free one (§13 task 6.9a).
    expectDispatchesWereWellFormed(fleet, { sweeps: 1 });

    // And the lock did not outlive the actor — `runTriageActor` releases in a
    // `finally`, so a third actor can start. Asserted by TAKING it rather than
    // by stat-ing a path, which is the property that actually matters.
    const after = await acquireTriageActorLock(env);
    expect(after, "the actor kept §7.7's lock past its own exit").not.toBeNull();
    await after!.release();
  });

  /**
   * §6.3b's refusal reaches the OPERATOR as a nonzero exit, and this is the
   * policy stated as a test.
   *
   * A `--poll` that returns `0` having never polled is indistinguishable — over
   * the only channel a machine caller has — from one that ran all day and stopped
   * cleanly. `console_gone` is the contrast and it stays `0`: that actor ran, and
   * its console ending is the end of a life rather than a refusal to start.
   *
   * The reason goes to stderr in BOTH cases and to stdout in NEITHER, because a
   * `--json` consumer parses stdout line by line.
   */
  test("`refused` exits BACKEND_UNAVAILABLE and `console_gone` still exits 0", async () => {
    const reason = "another triage actor holds /fixture/triage-relay.lock; this one started nothing";
    const refused = await runTriage(
      ["--poll", "300"],
      stubDeps({ loop: async () => ({ kind: "refused", reason, passes: 0 }) }),
    );
    expect(refused.err).toBeInstanceOf(CliError);
    expect((refused.err as CliError).exitCode).toBe(EXIT.BACKEND_UNAVAILABLE);
    expect((refused.err as CliError).message).toBe(reason);
    expect(refused.out).toBe("");

    const gone = await runTriage(
      ["--poll", "300"],
      stubDeps({
        loop: async () => ({
          kind: "console_gone",
          worker: TRIAGE_COLLATOR,
          run_id: "r-1",
          passes: 5,
          reason: "tri-1 was not live for 5 passes",
        }),
      }),
    );
    expect(gone.err).toBeNull();
    expect(gone.errOut).toContain("tri-1 was not live for 5 passes");
    expect(gone.out).toBe("");
  });
});

describe("§13 task 6.5b: --poll recycles, through the composition root's own effects", () => {
  /**
   * **§6.6 layer 4 clause 1 end to end: a seat with no pin is REPAIRED and the
   * console is swept in the same cadence**, which is the edge §6.6 chose
   * deliberately (*"The boundary runs BEFORE the pass … this is the one that
   * repairs soonest"*).
   *
   * It also pins the `downSeat` contract that the composition root satisfies
   * structurally rather than with a branch: *"Must be a no-op on a seat that is
   * already down."* `obs-t1` has no run, so the console's own `resolveSeatRuns`
   * finds nothing to hand `downRun` and the root's teardown is never reached —
   * asserted by the recycle log holding an `up` and NO `down`.
   */
  test("a seat with no run is brought back, and only THEN is the sweep admitted", async () => {
    const fleet = await fixtureFleet("2026-09-06T03-00-00Z-2001");
    const first = fleet.run;
    /*
     * `obs-t1` is the seat this console lost, and the directory is removed AFTER
     * `fixtureFleet` rather than before: that helper materialises both of its
     * seats itself, so a run tree built short would be silently made whole again
     * and the boundary would find nothing due — a vacuous pass rather than a test.
     */
    await rm(join(first.workersDir, "obs-t1"), { recursive: true, force: true });
    expect((await resolveSeatRuns(ALL_SEATS, fleet.effects.env))["obs-t1"]).toBeUndefined();
    let repaired: RunPaths | null = null;
    const stop = new AbortController();
    const effects: TriageProductionEffects = boundedByTheWatch(
      {
        ...fleet.effects,
        upSeat: async (seat) => {
          fleet.recycled.push(`up ${seat}`);
          // A REAL new run, because the gate re-derives its pins from the run
          // tree and a stub that only recorded would leave the seat unresolved
          // forever — which is also the shape that spins the loop, hence the
          // watch-side bound.
          repaired = await runHolding("2026-09-06T03-30-00Z-2002", [seat]);
        },
      },
      stop,
    );

    const deps = productionTriageDeps(async () => effects);
    const exit = await deps.loop(async () => await deps.pass(), {
      cadenceS: 1,
      signal: stop.signal,
    });

    expect(exit).toEqual({ kind: "stopped", passes: 1 });
    // The repair, and the `down` that correctly did not happen.
    expect(fleet.recycled).toEqual(["up obs-t1"]);
    expect(repaired).not.toBeNull();
    // The sweep was admitted only after the pin re-derivation found the seat.
    expectDispatchesWereWellFormed(fleet, { sweeps: 1 });
    // §7.7's record carries the repaired pin and every seat's stamp.
    const record = await readTriageActorRecord(effects.env);
    expect(record.kind).toBe("ok");
    if (record.kind !== "ok") return;
    expect(record.record.runs["obs-t1"]).toBe(repaired!.runId);
    expect(record.record.runs[TRIAGE_COLLATOR]).toBe(first.runId);
    expect(Object.keys(record.record.recycled_at ?? {}).sort()).toEqual([...ALL_SEATS].sort());
  });

  /**
   * **THE WATCH FOLLOWS A COLLATOR THIS ACTOR RECYCLED, AND ONLY THAT ONE.**
   *
   * §12 reads *"a `tri-1` that comes back in a NEW run is a console that went
   * away — correctly — rather than one that silently followed it"*, and that
   * sentence predates the actor being able to mint a run. Taken whole it makes
   * §6.6 layer 4 self-defeating: the first recycle of `tri-1` replaces the
   * collator's run, `isLiveWorker` reads the OLD run's dead state, and
   * `RELAY_ABANDON_PASSES` negatives later the actor abandons a console it had
   * just repaired.
   *
   * So `TriageConsolePorts.upSeat` re-derives the watched run at the moment its
   * `up` resolves, and nothing else moves it. The assertion is by VALUE and the
   * counterfactual is what makes it sharp: the watch observed the NEW run and
   * never the old one, on a fixture where the old one is what a naive binding
   * would have kept.
   */
  test("the run the watch observes moves to the recycled collator's, and to nothing else", async () => {
    const before = await runHolding("2026-09-06T04-00-00Z-3001", ALL_SEATS);
    const fleet = await fixtureFleet(before.runId);
    const env = fleet.effects.env;

    // §7.7's record makes `tri-1` — and ONLY `tri-1` — due at the first boundary.
    await mkdir(dirname(triageActorRecordPath(env)), { recursive: true });
    await writeTriageActorRecord(
      triageActorRecordPath(env),
      triageActorRecord(
        {
          pid: process.pid,
          started: "fixture-start-token",
          started_at: "2026-09-06T03:59:00.000Z",
          log_path: triageActorLogPath(env),
          pinned: null,
          cadence_s: 300,
          workers: ALL_SEATS,
        },
        {
          runs: Object.fromEntries(ALL_SEATS.map((s) => [s, before.runId])),
          sweep_cursor: 100,
          consecutive_skips: 0,
          // 100 - 0 ≥ 48 for the collator; 100 - 100 < 48 for the observer.
          recycled_at: Object.fromEntries(
            ALL_SEATS.map((s) => [s, s === TRIAGE_COLLATOR ? 0 : 100]),
          ),
        },
      ),
    );

    let after: RunPaths | null = null;
    const watched: string[] = [];
    const stop = new AbortController();
    const effects: TriageProductionEffects = boundedByTheWatch(
      {
        ...fleet.effects,
        upSeat: async (seat) => {
          fleet.recycled.push(`up ${seat}`);
          after = await runHolding("2026-09-06T04-30-00Z-3002", [seat]);
        },
      },
      stop,
      // The bound and the observation are the same call, which is the point: the
      // watch is what this test measures AND what stops the loop.
      { onObserve: (run) => watched.push(run.runId) },
    );

    const deps = productionTriageDeps(async () => effects);
    /*
     * A STUB pass, because this test is about the WATCH and not about a sweep:
     * the recycle moves the collator into a run with no inbox, and a real pass
     * there would be asserting `triagePass`'s behaviour on a bare run tree
     * instead of the one fact this test exists for.
     */
    const exit = await deps.loop(
      async () => ({
        ...NOTHING_OUTCOME,
        cursor: { runs: {}, sweep_cursor: 101, consecutive_skips: 0 },
      }),
      { cadenceS: 1, signal: stop.signal },
    );

    expect(exit).toEqual({ kind: "stopped", passes: 1 });
    // THE PREMISE: the collator really was recycled, out of the run the actor
    // started watching. Without this the assertion below is vacuous.
    expect(fleet.recycled).toEqual([`down ${before.runId}`, `up ${TRIAGE_COLLATOR}`]);
    expect(after).not.toBeNull();
    // THE POINT: the watch observed the new run and never the old one.
    expect(watched).toEqual([after!.runId]);
    expect(watched).not.toContain(before.runId);
    // The stub pass dispatched nothing, stated rather than assumed.
    expectDispatchesWereWellFormed(fleet, { sweeps: 0 });
  });
});

// ---------------------------------------------------------------------------
// §13 task 6.9 — §7.8's `cadence_s` reaches the clock
// ---------------------------------------------------------------------------

/**
 * §7.8's schema default for `cadence_s`, which is also the number the deleted
 * `DEFAULT_POLL_S` fallback held.
 *
 * **The two coinciding is what made the defect silent**, so every fixture below
 * moves off it deliberately and says so: a console left at 300 cannot tell a
 * cadence that came from the file apart from one that came from a literal in the
 * action.
 */
const SCHEMA_DEFAULT_CADENCE_S = 300;
/** What `triage/console.yaml` says. Deliberately not the default above. */
const FILE_CADENCE_S = 600;
/** What the operator types. Deliberately neither of the two above. */
const HAND_RUN_CADENCE_S = 120;

const FIXTURE_CONSOLE_SLOW = `
version: 1
cadence_s: ${FILE_CADENCE_S}
`;

describe("§13 task 6.9: §7.8's cadence_s reaches --poll, and --poll overrides it", () => {
  /**
   * **THE PREMISE, and it is the whole reason the two tests below are worth
   * anything.** §7.8's default and the action's old fallback are the same
   * number, so a fixture that left `cadence_s` at 300 would pass against the
   * defect: 300 reaches the actor whether the file was read or not.
   */
  test("the three cadences these fixtures use are three DIFFERENT numbers", () => {
    expect(FILE_CADENCE_S).not.toBe(SCHEMA_DEFAULT_CADENCE_S);
    expect(HAND_RUN_CADENCE_S).not.toBe(SCHEMA_DEFAULT_CADENCE_S);
    expect(HAND_RUN_CADENCE_S).not.toBe(FILE_CADENCE_S);
  });

  /**
   * **The ACTION's half: an absent `--poll` is `null`, not a number.**
   *
   * This is the contract change task 6.9 names — *"`TriageCommandDeps.loop`'s
   * `cadenceS` becomes nullable so 'not overridden' is spellable"*. Without it
   * the action resolved the interval itself and the file could not be consulted,
   * because the loop had already been handed an answer.
   *
   * Both directions in one test, because each is vacuous alone: that a bare run
   * passes `null` holds against an action that passes `null` always, and that
   * `--poll 120` passes `120` holds against the shipped defect.
   */
  test("an absent --poll reaches the loop as null; --poll reaches it as its number", async () => {
    const seen: (number | null)[] = [];
    const capture = stubDeps({
      loop: async (_pass, opts) => {
        seen.push(opts.cadenceS);
        return { kind: "stopped", passes: 0 };
      },
    });

    expect((await runTriage([], capture)).err).toBeNull();
    expect((await runTriage(["--poll", String(HAND_RUN_CADENCE_S)], capture)).err).toBeNull();

    expect(seen).toEqual([null, HAND_RUN_CADENCE_S]);
    // Stated by value rather than left to the reader: the action holds no
    // fallback of its own any more, so the schema default cannot appear here.
    expect(seen).not.toContain(SCHEMA_DEFAULT_CADENCE_S);
  });

  /**
   * **The PRODUCTION half, end to end, asserted by value at the seam.**
   *
   * A `triage/console.yaml` saying `cadence_s: 600` and no `--poll` at all: the
   * number that reaches the actor is the file's, and it is observable in §7.7's
   * record — written from the same `identity` the actor's `sleep` is driven by,
   * so the record cannot say 600 while the clock ticks at 300.
   *
   * **The cross-check is the deadline**, and it is what makes this more than one
   * number moving: `sweep_deadline_s` is `cadence_s − reserve_s` (§7.8 property
   * 1) and reaches the root's dispatch factory as a bound. At `cadence_s: 600`
   * and the default `reserve_s: 60` that is 540 s. The SAME file value arrives at
   * two consumers by two different routes, and a mutant that hardcoded either
   * one disagrees with the other.
   *
   * Bounded by {@link boundedBeforeTheSleep}: 600 s is a real cadence, and no
   * post-sleep bound can afford one.
   */
  test("console.yaml's cadence_s is what the actor records and what the deadline is cut from", async () => {
    const fleet = await fixtureFleet("2026-09-06T05-00-00Z-6001", {
      console: FIXTURE_CONSOLE_SLOW,
      settleDeadlineMs: (FILE_CADENCE_S - 60) * 1_000,
    });
    const observations = { count: 0 };
    const deps = productionTriageDeps(async () =>
      boundedBeforeTheSleep(fleet.effects, observations),
    );

    const started = Date.now();
    const exit = await deps.loop(async () => await deps.pass(), {
      cadenceS: null,
      tolerance: 1,
    });

    // The loop ended at the WATCH, before any sleep — so no timer outlived it
    // and the next test file cannot inherit one (round 18 rule 4).
    expect(exit.kind).toBe("console_gone");
    expect(observations.count).toBe(1);
    expect(Date.now() - started).toBeLessThan(10_000);

    // THE POINT: §7.8's number, and not the schema default the action held.
    const record = await readTriageActorRecord(fleet.effects.env);
    expect(record.kind).toBe("ok");
    if (record.kind !== "ok") return;
    expect(record.record.cadence_s).toBe(FILE_CADENCE_S);
    expect(record.record.cadence_s).not.toBe(SCHEMA_DEFAULT_CADENCE_S);

    // THE CROSS-CHECK: the same file value reached by the other route. Asserted
    // out here and not inside `dispatchFor`, because the loop swallows what the
    // pass throws and a swallowed `expect` is not an assertion.
    expect(fleet.deadlines).toEqual([(FILE_CADENCE_S - 60) * 1_000]);
    expectDispatchesWereWellFormed(fleet, { sweeps: 1 });
  });

  /**
   * **`--poll` overrides the CLOCK and deliberately not the DEADLINE**, and the
   * second half of that sentence is the one a later edit gets wrong.
   *
   * §7.8 property 1 computes `sweep_deadline_s` from `cadence_s`, so propagating
   * the override into it looks like consistency. It is not: `--poll` is validated
   * only as *a positive number of seconds*, while `cadence_s` carries `min(60)`
   * AND `reserveFitsCadence` — so `--poll 30` against the default `reserve_s: 60`
   * would compute a deadline of −30 s, a sweep late before it started, reached
   * through a path with none of the schema's refusals in it.
   *
   * A `--poll` shorter than the deadline is not unhandled, it is ALREADY handled:
   * the next tick meets a sweep still in flight, §6.4's gate skips it by name and
   * `max_consecutive_skips` announces it. A degradation the console reports beats
   * a negative deadline it cannot.
   */
  test("--poll moves the actor's clock and leaves §7.8's deadline where the file put it", async () => {
    const fleet = await fixtureFleet("2026-09-06T05-30-00Z-6002", {
      console: FIXTURE_CONSOLE_SLOW,
      settleDeadlineMs: (FILE_CADENCE_S - 60) * 1_000,
    });
    const observations = { count: 0 };
    const deps = productionTriageDeps(async () =>
      boundedBeforeTheSleep(fleet.effects, observations),
    );

    const exit = await deps.loop(async () => await deps.pass(), {
      cadenceS: HAND_RUN_CADENCE_S,
      tolerance: 1,
    });
    expect(exit.kind).toBe("console_gone");

    const record = await readTriageActorRecord(fleet.effects.env);
    expect(record.kind).toBe("ok");
    if (record.kind !== "ok") return;
    // The clock is the operator's.
    expect(record.record.cadence_s).toBe(HAND_RUN_CADENCE_S);
    // The deadline is still the file's, cut from `cadence_s` and not from
    // `--poll`. Both numbers in one test, because either alone is satisfied by
    // an implementation that moved both or neither.
    expect(fleet.deadlines).toEqual([(FILE_CADENCE_S - 60) * 1_000]);
    expect(fleet.deadlines).not.toContain((HAND_RUN_CADENCE_S - 60) * 1_000);
    // And the sweep whose deadline that is really happened — without this, an
    // empty `deadlines` would satisfy neither line above but a one-element one
    // built by a truncated pass still would (§13 task 6.9a).
    expectDispatchesWereWellFormed(fleet, { sweeps: 1 });
  });
});

// ---------------------------------------------------------------------------
// §13 task 6.5c — a console with no collator at start
// ---------------------------------------------------------------------------

/**
 * The observers — i.e. every seat EXCEPT the collators.
 *
 * A fleet materialised from these alone is a console with NO collator, which is
 * what task 6.5c is about. That was ONE missing seat while the console had one
 * collator and is TWO since 2026-09-12, so the repairs below stand up two — and
 * the watch is still pinned to `TRIAGE_COLLATOR`, which is a separate fact.
 */
const OBSERVER_SEATS = TRIAGE_CONSOLE_ASPECTS.map((s) => s.worker);

describe("§13 task 6.5c: an actor may START into a console with no collator", () => {
  /**
   * **THE DECISION, and both of its halves in one test because each alone is
   * satisfied by the wrong implementation.**
   *
   * §6.6 layer 4's boundary condition is *"is this seat's run older than
   * `recycle_after_sweeps`, or ABSENT"*, and the absent arm repaired three seats
   * of four. `tri-1` was the exception, and nothing decided that it should be:
   * `productionTriageDeps.loop` resolved the collator before it built the ports,
   * so the repair machinery was unreachable from exactly the state it exists to
   * repair. A console whose collator was gone at START could not be repaired by
   * the thing built to repair it; one whose collator went away a minute LATER
   * could.
   *
   * **So the refusal narrows from the COMMAND to the PASS.** `--once` is
   * somebody's command and its exit code should mean something (§6.4), so it
   * still refuses by name on this very tree — asserted first, because without it
   * the second half would be satisfied by deleting the refusal outright.
   * `--poll` is a request to keep a console running, and standing an absent seat
   * up at minute zero is the same act it already performs at hour four.
   *
   * The third assertion is the one that makes this a repair rather than a log
   * line: the GATE opened. §6.6 withholds every sweep while any pin is
   * unresolved, so a pass that ran is proof the re-derivation found `tri-1`.
   */
  test("--once still refuses by name where --poll now stands the collator up", async () => {
    const fleet = await fixtureFleet("2026-09-06T06-00-00Z-7001", { seats: OBSERVER_SEATS });
    const env = fleet.effects.env;
    // THE PREMISE: this really is a console with no collator.
    expect((await resolveSeatRuns([TRIAGE_COLLATOR], env))[TRIAGE_COLLATOR]).toBeUndefined();

    // HALF ONE — the pass refuses, by name, with the message it always had.
    const { err } = await runTriage(["--once"], productionTriageDeps(async () => fleet.effects));
    expect(err).toBeInstanceOf(CliError);
    expect((err as CliError).message).toBe(NO_COLLATOR_RUN);
    expect((err as CliError).exitCode).toBe(EXIT.USAGE);

    // HALF TWO — the loop starts anyway, and repairs the seat the pass refused
    // to sweep into.
    let repaired: RunPaths | null = null;
    let passes = 0;
    const watched: string[] = [];
    const stop = new AbortController();
    const effects: TriageProductionEffects = boundedByTheWatch(
      {
        ...fleet.effects,
        upSeat: async (seat) => {
          fleet.recycled.push(`up ${seat}`);
          repaired = await runHolding("2026-09-06T06-30-00Z-7002", [seat]);
        },
      },
      stop,
      { onObserve: (run) => watched.push(run.runId) },
    );

    const deps = productionTriageDeps(async () => effects);
    const exit = await deps.loop(
      async () => {
        passes += 1;
        return { ...NOTHING_OUTCOME, cursor: { runs: {}, sweep_cursor: 1, consecutive_skips: 0 } };
      },
      { cadenceS: 1, signal: stop.signal },
    );

    expect(exit).toEqual({ kind: "stopped", passes: 1 });
    // ONLY the collators were due: both observers are present and unstamped,
    // and there was no run to hand `downRun`, so the repair is one `up` each.
    // Sorted, because nothing orders the repair of two independent seats.
    expect([...fleet.recycled].sort()).toEqual(
      TRIAGE_CONSOLE_ROSTER.collators.map((c) => `up ${c}`).sort(),
    );
    expect(repaired).not.toBeNull();
    // THE GATE OPENED — the repair reached the pass and not merely the log.
    expect(passes).toBe(1);
    // And the thing that used to throw now resolves, to the run this actor minted.
    expect((await resolveCollatorRun(env)).runId).toBe(repaired!.runId);
    // The watch followed it, so the console it observes is the one it repaired.
    expect(watched).toEqual([repaired!.runId]);
    // Neither half dispatched: the `--once` refused before the driver, and the
    // loop's pass is a stub.
    expectDispatchesWereWellFormed(fleet, { sweeps: 0 });
  });

  /**
   * **THE ANTI-TWIN: a cold console whose repair FAILS abandons rather than
   * polling forever.**
   *
   * This is the cost of the decision above, paid deliberately. Starting into a
   * missing collator means the watch has no run to observe on its first
   * iteration, and the two ways to spell that are not equally safe:
   *
   *   - **`unverifiable`** — the posture `triageActorLoop` gives a probe that
   *     THROWS, which leaves the streak where it is. Spelt that way here, an
   *     actor whose `up` can never succeed is IMMORTAL: it withholds every sweep
   *     on §6.6's gate, never observes a negative, and polls a console that does
   *     not exist for the rest of the host's life. That is ISC-926's defect
   *     reached through a different door.
   *   - **`false`** — a negative observation, which is what this console ships.
   *     No run holds `tri-1`; that is the most definitive possible answer to
   *     *"is the console still there"*, and it is the same answer the shipped
   *     mid-life path already gives (`upSeat`'s `finally` leaves the watch on a
   *     dead run, which reads `false`). Cold and mid-life now agree.
   *
   * `observations.count` is the assertion that makes this exact rather than
   * approximate: the INJECTED `isCollatorLive` is never reached, so the `false`
   * came from the absent run and not from an effect that happened to say so.
   */
  test("a cold console whose repair keeps failing abandons instead of polling forever", async () => {
    const fleet = await fixtureFleet("2026-09-06T07-00-00Z-7003", { seats: OBSERVER_SEATS });
    const observations = { count: 0 };
    let ups = 0;
    let passes = 0;
    const effects: TriageProductionEffects = {
      ...fleet.effects,
      // The root's effect, which MUST NOT be reached: there is no run to hand it.
      isCollatorLive: async () => {
        observations.count += 1;
        return true;
      },
      upSeat: async () => {
        ups += 1;
        throw new Error("the host refused to start the collator");
      },
    };

    const deps = productionTriageDeps(async () => effects);
    const exit = await deps.loop(
      async () => {
        passes += 1;
        return NOTHING_OUTCOME;
      },
      { cadenceS: 1, tolerance: 1 },
    );

    // It ended, and it ended for the right reason.
    expect(exit.kind).toBe("console_gone");
    expect(exit.kind === "console_gone" && exit.worker).toBe(TRIAGE_COLLATOR);
    // THE PREMISE: it really did try to repair the seats first — one attempt
    // per collator, because a cold console is missing both and the repair does
    // not stop at the first throw.
    expect(ups).toBe(TRIAGE_CONSOLE_ROSTER.collators.length);
    // §6.6's gate held the sweep while `tri-1` was unresolved, which is the
    // clause that would make an `unverifiable` watch immortal.
    expect(passes).toBe(0);
    // THE POINT: the negative came from the absent run, not from the effect.
    expect(observations.count).toBe(0);
    expectDispatchesWereWellFormed(fleet, { sweeps: 0 });
  });

  /**
   * **The same rule MID-LIFE: a recycle whose `up` fails drops the watch rather
   * than leaving it on a run that is gone.**
   *
   * `TriageConsolePorts.upSeat`'s `finally` re-derives the watched run, and
   * task 6.5c changed which reader it uses — {@link collatorRun} rather than
   * {@link resolveCollatorRun}, so *"no run holds `tri-1`"* is recorded as the
   * `null` it is instead of arriving as a throw and being swallowed by a
   * `catch` that was written for a broken run tree.
   *
   * **That edit is invisible on every other fixture in this file, which is why
   * this test exists.** When the `up` SUCCEEDS both readers return the new run;
   * when it fails and the old directory survives both return the old one. The
   * two disagree on exactly one state — the collator's directory is gone — and
   * there the old spelling left the watch pointing at a run that no longer
   * exists and then OBSERVED it. Measured: without this test the revert
   * survived the whole battery.
   *
   * `observations.count` is again the instrument, and it is exact rather than
   * approximate: the injected `isCollatorLive` says the console is HEALTHY, so
   * an actor that reached it would not abandon at all.
   */
  test("a recycle whose up fails drops the watch instead of observing a run that is gone", async () => {
    const fleet = await fixtureFleet("2026-09-06T08-00-00Z-7005");
    const env = fleet.effects.env;

    // §7.7's record makes `tri-1` — and only `tri-1` — due at the first boundary.
    await mkdir(dirname(triageActorRecordPath(env)), { recursive: true });
    await writeTriageActorRecord(
      triageActorRecordPath(env),
      triageActorRecord(
        {
          pid: process.pid,
          started: "fixture-start-token",
          started_at: "2026-09-06T07:59:00.000Z",
          log_path: triageActorLogPath(env),
          pinned: null,
          cadence_s: 300,
          workers: ALL_SEATS,
        },
        {
          runs: Object.fromEntries(ALL_SEATS.map((s) => [s, fleet.run.runId])),
          sweep_cursor: 100,
          consecutive_skips: 0,
          recycled_at: Object.fromEntries(
            ALL_SEATS.map((s) => [s, s === TRIAGE_COLLATOR ? 0 : 100]),
          ),
        },
      ),
    );

    const observations = { count: 0 };
    let ups = 0;
    const effects: TriageProductionEffects = {
      ...fleet.effects,
      /*
       * A teardown that really removes the seat, which is the state the two
       * readers disagree about. A `down` alone does not produce it — run
       * directories outlive a stopped container — so the fixture reaches it the
       * way the run tree otherwise would, by the directory being gone.
       */
      downRun: async (runId) => {
        fleet.recycled.push(`down ${runId}`);
        await rm(join(runPaths(runId, env["PIFLEET_RUNS_DIR"]!).workersDir, TRIAGE_COLLATOR), {
          recursive: true,
          force: true,
        });
      },
      upSeat: async () => {
        ups += 1;
        throw new Error("the host refused to start the collator");
      },
      // HEALTHY, so an actor that observed the stale run would not abandon.
      isCollatorLive: async () => {
        observations.count += 1;
        return true;
      },
    };

    const deps = productionTriageDeps(async () => effects);
    const exit = await deps.loop(async () => NOTHING_OUTCOME, { cadenceS: 1, tolerance: 1 });

    // THE PREMISE, in two halves: the recycle was attempted, and it left a
    // console no run holds the collator for.
    expect(fleet.recycled).toEqual([`down ${fleet.run.runId}`]);
    expect(ups).toBe(1);
    expect((await resolveSeatRuns([TRIAGE_COLLATOR], env))[TRIAGE_COLLATOR]).toBeUndefined();

    // THE POINT: the watch was dropped, so the healthy-looking stale run was
    // never observed and the actor abandoned on the absence itself.
    expect(exit.kind).toBe("console_gone");
    expect(observations.count).toBe(0);
    expectDispatchesWereWellFormed(fleet, { sweeps: 0 });
  });
});

// ---------------------------------------------------------------------------
// §6.3 step 4's read — and the difference between "not yet" and "refused"
// ---------------------------------------------------------------------------

/**
 * `readSweepPartition` collapses BOTH non-`ok` arms of `DispatchRequestRead` into
 * an empty partition, and that is deliberate — the pass turns an empty partition
 * into `partition_incomplete` naming every declared service, which is the reason
 * an operator can act on. What was NOT deliberate is that the refusal's own
 * `reason` was computed and then dropped, so the two arms became
 * indistinguishable from outside.
 *
 * **This is not hypothetical and the fixture below is the real one.** On the first
 * live triage console `tri-1` wrote a well-formed partition for ELEVEN consecutive
 * sweeps with `brief` as a JSON object rather than a string. Every one was refused
 * on the schema; no observer was ever dispatched; and the only thing the console
 * ever said was `sweep_produced_nothing` — which reads as *"I could not see the
 * environment"* when the truth was *"I could not read my own collator"*. Those are
 * different faults with different fixes, and the console pointed at the cluster.
 *
 * So the assertion is two-sided, and the second side is the load-bearing one: a
 * refusal MUST reach §7.7's log, and a merely-absent request must NOT — an actor
 * that logged every sweep whose collator had not answered yet would write a line
 * every tick, forever, into a file that is never truncated.
 */
describe("readSweepPartition tells a refused partition from an absent one", () => {
  const collatorRequest = (taskId: string, brief: unknown): Record<string, unknown> => ({
    schema: DISPATCH_REQUEST_SCHEMA,
    parent_task_id: taskId,
    requests: TRIAGE_CONSOLE_ASPECTS.map((s) => ({
      worker: s.worker,
      title: `${taskId} ${s.worker}`,
      brief,
      services: [`svc-${s.worker}`],
    })),
  });

  /** Captures stderr around one call, so the NEGATIVE case can be asserted too. */
  async function partitionWithLog(
    run: RunPaths,
    sweepId: string,
  ): Promise<{ assignments: readonly unknown[]; logged: string[] }> {
    const logged: string[] = [];
    const before = console.error;
    console.error = (...args: unknown[]): void => {
      logged.push(args.map(String).join(" "));
    };
    try {
      const assignments = await readSweepPartition(run, sweepId);
      return { assignments, logged };
    } finally {
      console.error = before;
    }
  }

  test("a well-formed partition is returned and says nothing", async () => {
    const run = runPaths("2026-09-07T10-00-00Z-ok01", process.env["PIFLEET_RUNS_DIR"]!);
    await writeJson(
      dispatchRequestPath(run.root, TRIAGE_COLLATOR, "T-sweep-1"),
      collatorRequest("T-sweep-1", "Observe one service and report one row."),
    );
    const { assignments, logged } = await partitionWithLog(run, "T-sweep-1");
    expect(assignments.length).toBe(TRIAGE_CONSOLE_ASPECTS.length);
    expect(logged).toEqual([]);
  });

  test("an OBJECT brief is refused, empty, and NAMED in the log", async () => {
    const run = runPaths("2026-09-07T10-00-00Z-ok02", process.env["PIFLEET_RUNS_DIR"]!);
    await writeJson(
      dispatchRequestPath(run.root, TRIAGE_COLLATOR, "T-sweep-2"),
      // The exact shape the live collator produced.
      collatorRequest("T-sweep-2", { sweep_id: "T-sweep-2", services: [{ service: "mia" }] }),
    );
    const { assignments, logged } = await partitionWithLog(run, "T-sweep-2");
    expect(assignments).toEqual([]);
    expect(logged.length).toBe(1);
    // Asserted on the CAUSE, not merely on "something was logged": a line that
    // did not name the field would leave the next operator where this one was.
    expect(logged[0]).toContain("brief");
    expect(logged[0]).toContain("REFUSED");
    expect(logged[0]).toContain("T-sweep-2");
    // And it must say the sweep produces nothing FOR THIS REASON, because
    // `sweep_produced_nothing` is what the operator will otherwise read.
    expect(logged[0]).toContain("not the environment");
  });

  test("an ABSENT request is empty and silent — the negative half", async () => {
    const run = runPaths("2026-09-07T10-00-00Z-ok03", process.env["PIFLEET_RUNS_DIR"]!);
    const { assignments, logged } = await partitionWithLog(run, "T-sweep-3");
    expect(assignments).toEqual([]);
    expect(logged).toEqual([]);
  });
});

/**
 * §6.6 layer 2's counter must outlive the actor, and until 2026-09-07 it did not.
 *
 * `triage-relay.json` was two things with opposite lifetimes: the pidfile
 * `scripts/triage`'s `stopActor` MUST delete (a pidfile outliving its process is
 * a pid the next stop signals blind) and the sweep cursor `resumedCursor` reads.
 * `seedCursor` tolerated an absent record *"because `highestSweepNumber`
 * re-derives the counter from the run tree"* — true while the run persists, false
 * across a recreate, which mints an EMPTY tree and stops the actor first. Both
 * sources read zero at the same moment.
 *
 * Observed: twelve restarts, twelve sweeps numbered `T-sweep-1`, against the rule
 * that no sweep ever reuses an id.
 */
describe("the sweep counter survives what deletes the pidfile", () => {
  test("the cursor is NOT the record path — deleting one leaves the other", async () => {
    const env = { ...process.env };
    expect(triageCursorPath(env)).not.toBe(triageActorRecordPath(env));
    expect(triageCursorPath(env)).toMatch(/-cursor\.json$/);
  });

  test("a written counter is read back after the record is gone", async () => {
    const base = await tempBase();
    const env = { HOME: base, PIFLEET_RUNS_DIR: join(base, ".pifleet", "runs") };
    await mkdir(join(base, ".pifleet"), { recursive: true });

    await writeTriageSweepCursor(41, env);
    // The record is what `stopActor` removes; it was never written here at all,
    // which is exactly the post-stop state.
    expect(existsSync(triageActorRecordPath(env))).toBe(false);
    expect(await readTriageSweepCursor(env)).toBe(41);
  });

  /**
   * The counter is a HINT that raises a floor, never a throw: a corrupt file must
   * not stop a console sweeping, because the run tree is still consulted and
   * `resumedCursor` takes the max of both.
   */
  /**
   * THE ONE THAT MATTERS, and the three above do not replace it.
   *
   * Those exercise the read/write helpers in isolation and stay green while
   * `seedCursor` ignores the file entirely — measured: stubbing the seed's read
   * to 0 left all three passing. What must be asserted is the ID THE CONSOLE
   * MINTS, because that is the thing §6.6 layer 2 is about.
   *
   * A persisted counter of 41 and a FRESH run tree — the exact post-recreate
   * state — must produce `T-sweep-42`, not `T-sweep-1`.
   */
  test("a persisted counter raises the next sweep id, against an empty run tree", async () => {
    const fleet = await fixtureFleet("2026-09-06T01-00-42Z-4242");
    await writeTriageSweepCursor(41, fleet.effects.env);
    const deps = productionTriageDeps(async () => fleet.effects);
    const { err } = await runTriage(["--once"], deps);
    expect(err).toBeNull();
    expect(fleet.dispatched[0]).toBe(`${TRIAGE_COLLATOR}:T-sweep-42`);
  });

  test("an absent or corrupt counter reads 0 rather than throwing", async () => {
    const base = await tempBase();
    const env = { HOME: base, PIFLEET_RUNS_DIR: join(base, ".pifleet", "runs") };
    await mkdir(join(base, ".pifleet"), { recursive: true });
    expect(await readTriageSweepCursor(env)).toBe(0);
    await writeFile(triageCursorPath(env), "{not json", "utf8");
    expect(await readTriageSweepCursor(env)).toBe(0);
  });
});
