/**
 * THE TRIAGE ACTOR'S RECORD, LOG, LOCK AND WATCH — SRD-TRIAGE-CONSOLE §7.7,
 * §6.4, §6.6 layer 4, §13 task 6.3.
 *
 * §13 task 6.3's acceptance is two of §12's criteria and they are a PAIR:
 *
 * > **Anti: the actor exits when its console is gone.** *Probe: a fixture where
 * > `tri-1` reports not-live for `RELAY_ABANDON_PASSES` passes; assert the loop
 * > returns and ledgers the reason. And the mirror: four negatives followed by
 * > one positive resets the streak — because transient read failures must not
 * > reap a healthy actor.*
 *
 * The mirror is not decoration. Without it the criterion is satisfied by an
 * actor that simply exits a lot, and "exits a lot" is a WORSE failure than the
 * one being prevented: a relay that reaps itself on a `ps` under load leaves the
 * console actorless with nothing on disk saying why, which is §6.5's *"background
 * process nobody can name"* reached through the mechanism built to close it.
 *
 * ## THE DEGENERATE FIXTURE THIS FILE IS BUILT AGAINST
 *
 * **A watch fixture in which the console was never present cannot tell "exited
 * because it went away" from "exited".** Every abandonment test here therefore
 * asserts its premise one step earlier — the probe was CALLED, the passes RAN —
 * and each has a control in which the console stays live and the loop is stopped
 * by its signal instead, returning a DIFFERENT exit kind after the same number of
 * passes. A loop that returned `console_gone` unconditionally passes the first
 * assertion of every abandonment test and fails every control.
 *
 * ## HERMETIC, AND THIS IS THE TASK WHERE THAT BITES
 *
 * `~/.pifleet` is keyed off `$HOME`, and this file writes a RECORD, a LOG and a
 * LOCK. A test that wrote real state would pollute the operator's machine and a
 * test that took the real lock could wedge the live triage console. So every
 * fixture pins `PIFLEET_RUNS_DIR` at a fresh temp directory — `runsRoot`'s
 * documented override and the seam every hermetic test in this repository uses —
 * and {@link assertHermetic} asserts each of the three paths is INSIDE it rather
 * than trusting that it is. No test here starts a timer, spawns a process, or
 * reaches the network: the loop's `sleep`, its pass, its liveness probe and its
 * clock are all injected.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import {
  RELAY_ABANDON_PASSES,
  RelayRecordSchema,
  readRelayStatus,
  relayLockPath,
  relayLogPath,
  relayRecordPath,
  servesConsole,
} from "../../src/run/console-relay.ts";
import { TRIAGE_CONSOLE_ROSTER } from "../../src/run/dispatch-request.ts";
import {
  TRIAGE_ACTOR_EVENT_KINDS,
  TRIAGE_COLLATOR,
  TRIAGE_CONSOLE,
  TriageActorRecordSchema,
  accountConsoleSpend,
  acquireTriageActorLock,
  actorLogLine,
  appendActorLog,
  parseTriageActorRecord,
  productionConsoleBudgetPorts,
  readTriageActorRecord,
  runTriageActor,
  seatsDueForRecycle,
  triageActorLockPath,
  triageActorLogPath,
  triageActorRecord,
  triageActorRecordPath,
  writeTriageActorRecord,
} from "../../src/run/triage-actor.ts";
import type {
  ConsoleBudgetPorts,
  TriageActorCursor,
  TriageActorDeps,
  TriageActorEvent,
  TriageConsolePorts,
} from "../../src/run/triage-actor.ts";
/**
 * **THE SHIPPED GATE, imported rather than re-described.** §13 task 6.8's whole
 * point is that the four links below `refuseOnExhaustedBudget` were already built
 * and had no first link; a test that asserted the produced FILE and stopped there
 * would be a second description of `halted_at`'s meaning rather than a join, and
 * ISC-891 was filed OPEN precisely because ISC-885's tests *"go on passing forever
 * whether or not this is ever closed"*.
 */
import { refuseOnExhaustedBudget } from "../../src/cli/commands/triage.ts";
import { runPaths, runsRoot } from "../../src/run/paths.ts";

// ---------------------------------------------------------------------------
// Fixtures — every one of them hermetic, and asserted to be
// ---------------------------------------------------------------------------

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) await rm(t, { recursive: true, force: true });
});

async function tempRunsDir(): Promise<Record<string, string | undefined>> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-triage-actor-"));
  temps.push(root);
  return { PIFLEET_RUNS_DIR: join(root, "runs"), HOME: root };
}

/**
 * The isolation, ASSERTED rather than assumed.
 *
 * `PIFLEET_RUNS_DIR` is the documented override, but a module that spelled its
 * own path from `homedir()` would ignore it silently and every test below would
 * still pass while writing into the operator's live console. The one assertion
 * that catches that is this one, so it runs in every fixture that touches disk.
 */
function assertHermetic(env: Record<string, string | undefined>): void {
  const root = env["HOME"]!;
  for (const p of [triageActorRecordPath(env), triageActorLogPath(env), triageActorLockPath(env)]) {
    expect(p.startsWith(`${root}/`), `${p} escaped the fixture root ${root}`).toBe(true);
  }
}

const WORKERS = ["tri-1", "obs-t1", "obs-t2", "obs-t3"] as const;

/** A fully pinned console: four seats, four runs (§6.1's correction). */
function fourRuns(): Record<string, string> {
  return { "tri-1": "r-tri", "obs-t1": "r-o1", "obs-t2": "r-o2", "obs-t3": "r-o3" };
}

function cursor(over: Partial<TriageActorCursor> = {}): TriageActorCursor {
  return { runs: fourRuns(), sweep_cursor: 7, consecutive_skips: 0, ...over };
}

function identity(env: Record<string, string | undefined>) {
  return {
    pid: process.pid,
    started: "utc1 whatever",
    started_at: "2026-09-06T18:19:23.481Z",
    log_path: triageActorLogPath(env),
    pinned: null,
    cadence_s: 300,
    workers: [...WORKERS],
  };
}

/** A recorder for the loop's log, so a test asserts events rather than bytes. */
function logSpy(): { events: TriageActorEvent[]; log: (e: TriageActorEvent) => Promise<void> } {
  const events: TriageActorEvent[] = [];
  return {
    events,
    log: async (e) => {
      events.push(e);
    },
  };
}

/**
 * A loop harness whose every exit is BOUNDED.
 *
 * §13's warning applies exactly here: *"a guard whose bad state is 'the condition
 * never becomes true' can HANG rather than fail"*, and a watch is that shape. So
 * the harness aborts after `maxPasses` observations no matter what the fixture
 * says, and a loop that never abandons returns `stopped` rather than running
 * until the test runner gives up.
 */
function harness(opts: {
  live: readonly boolean[];
  maxPasses?: number;
  pass?: (n: number) => Promise<TriageActorCursor>;
  probe?: (n: number) => Promise<boolean>;
}) {
  const spy = logSpy();
  const controller = new AbortController();
  const sleeps: number[] = [];
  let passes = 0;
  let probes = 0;
  const max = opts.maxPasses ?? opts.live.length;
  const deps: TriageActorDeps = {
    pass: async () => {
      passes += 1;
      return opts.pass === undefined ? cursor() : await opts.pass(passes);
    },
    isCollatorLive: async () => {
      probes += 1;
      if (opts.probe !== undefined) return await opts.probe(probes);
      // Past the scripted end the console stays in its last observed state.
      return opts.live[probes - 1] ?? opts.live.at(-1) ?? true;
    },
    saveCursor: async () => {},
    log: spy.log,
    sleep: async (ms) => {
      sleeps.push(ms);
      if (sleeps.length >= max) controller.abort();
    },
    /**
     * **A SEATLESS console, because §13 task 6.5b made `ports` REQUIRED and this
     * harness serves the tests that are about something else.**
     *
     * `seats: []` is what makes this ports object decide nothing: the boundary
     * finds nobody due, the gate finds no pin unresolved, and the lock is a fake
     * one that touches no file — so every test below that spreads
     * `{ ...deps, ports: p.ports }` still states its own ports, and every test
     * that does not is running the same loop it ran when `ports` was optional.
     *
     * The one visible difference is that a ported actor always folds its
     * per-seat clock into the saved cursor, so a seatless one saves
     * `recycled_at: {}` where an un-ported one saved nothing. That is asserted
     * by value in *"the pass's cursor is what reaches the record"* rather than
     * left to be discovered.
     */
    ports: recyclePorts({ seats: [], runs: [{}] }).ports,
  };
  return {
    deps,
    spy,
    sleeps,
    signal: controller.signal,
    counts: () => ({ passes, probes }),
  };
}

// ---------------------------------------------------------------------------
// §6.6 layer 4 and §6.3b — the unattended half, and the fixtures it needs
// ---------------------------------------------------------------------------

/**
 * A recorder for the recycle's two effects and its two reads.
 *
 * **Every `down` and every `up` is injected**, so no test here recreates a real
 * container, and the port that would is not reachable from this module at all —
 * `test/unit/triage-readonly.test.ts` bans `cli/commands/up.ts`,
 * `cli/commands/down.ts` and `Bun.spawn` from the console's own subtree by name,
 * which is why the effect arrives as a function rather than as an import.
 *
 * `seatRuns` is SCRIPTED rather than constant: §6.6's gate is *"four pins
 * re-derived, not four containers running"*, and a stub that answered the same map
 * before and after the recycle could not tell the two moments apart.
 */
function recyclePorts(opts: {
  readonly seats?: readonly string[];
  /** One answer per `seatRuns()` call; the last one repeats. */
  readonly runs: readonly Readonly<Record<string, string>>[];
  readonly recycleAfterSweeps?: number;
  readonly inFlight?: boolean | (() => Promise<boolean>);
  readonly resume?: TriageActorCursor | null;
  readonly acquireLock?: () => Promise<{ release: () => Promise<void> } | null>;
  readonly downSeat?: (seat: string) => Promise<void>;
  readonly upSeat?: (seat: string) => Promise<void>;
  readonly seatRuns?: () => Promise<Readonly<Record<string, string>>>;
  readonly lockPath?: string;
  readonly budget?: TriageConsolePorts["budget"];
}) {
  const downs: string[] = [];
  const ups: string[] = [];
  let reads = 0;
  let releases = 0;
  const ports: TriageConsolePorts = {
    /*
     * §6.10's ports, inert: `ceiling` answers a number nothing crosses and
     * `publish` records nothing, so the budget half of the boundary decides
     * nothing in fixtures that are not about it. The tests that ARE about it
     * override this member. Required as of 2026-09-07, when the composition root
     * grew `budget: productionConsoleBudgetPorts(e.env)`.
     */
    budget: opts.budget ?? {
      ceiling: async () => Number.MAX_SAFE_INTEGER,
      persisted: async () => null,
      seatTokens: async () => 0,
      publish: async () => {},
    },
    seats: opts.seats ?? [...WORKERS],
    lockPath: opts.lockPath ?? "/fixture/triage-relay.lock",
    recycleAfterSweeps: opts.recycleAfterSweeps ?? 48,
    acquireLock:
      opts.acquireLock ??
      (async () => ({
        release: async () => {
          releases += 1;
        },
      })),
    resume: async () => opts.resume ?? null,
    sweepInFlight:
      typeof opts.inFlight === "function" ? opts.inFlight : async () => opts.inFlight === true,
    seatRuns:
      opts.seatRuns ??
      (async () => {
        reads += 1;
        return opts.runs[reads - 1] ?? opts.runs.at(-1) ?? {};
      }),
    downSeat:
      opts.downSeat ??
      (async (seat) => {
        downs.push(seat);
      }),
    upSeat:
      opts.upSeat ??
      (async (seat) => {
        ups.push(seat);
      }),
  };
  return { ports, downs, ups, counts: () => ({ reads, releases }) };
}

/** The four seats, all pinned, all recycled at the same recent sweep. */
const ALL_FRESH = { "tri-1": 100, "obs-t1": 100, "obs-t2": 100, "obs-t3": 100 } as const;
/** The four seats, all pinned, all stamped long enough ago to be due at 48. */
const ALL_STALE = { "tri-1": 40, "obs-t1": 40, "obs-t2": 40, "obs-t3": 40 } as const;

function resumed(over: Partial<TriageActorCursor> = {}): TriageActorCursor {
  return {
    runs: fourRuns(),
    sweep_cursor: 100,
    consecutive_skips: 0,
    recycled_at: { ...ALL_STALE },
    ...over,
  };
}

// ---------------------------------------------------------------------------
// The three paths — §12's actor-record anti-criterion, re-taken through the
// accessors the console's own modules will actually call
// ---------------------------------------------------------------------------

describe("the record, log and lock are the TRIAGE console's (§7.7, §9.13)", () => {
  test("no triage path is any review path", async () => {
    const env = await tempRunsDir();
    assertHermetic(env);
    const triage = [triageActorRecordPath(env), triageActorLogPath(env), triageActorLockPath(env)];
    const review = [
      relayRecordPath("review", env),
      relayLogPath("review", env),
      relayLockPath("review", env),
    ];
    // Disjointness over the whole product, not pairwise by index: the failure
    // being prevented is a triage actor claiming ANY review file, not a triage
    // record landing at the review record's name in particular.
    for (const t of triage) for (const r of review) expect(t).not.toBe(r);
    expect(new Set([...triage, ...review]).size).toBe(6);
  });

  /**
   * The accessors are the SAME paths Phase 2.3 parameterised, not a second
   * spelling of them.
   *
   * A module that computed `~/.pifleet/triage.json` itself — §7.7's literal
   * wording — would pass the disjointness test above and would still be wrong:
   * `scripts/triage --actor-stop` reads the path through `relayRecordPath`, so
   * two spellings means a stop that signals nobody and a record no manager
   * reads.
   */
  test("they ARE `relay*Path(\"triage\")`, so the stop path and the write path agree", async () => {
    const env = await tempRunsDir();
    expect(triageActorRecordPath(env)).toBe(relayRecordPath("triage", env));
    expect(triageActorLogPath(env)).toBe(relayLogPath("triage", env));
    expect(triageActorLockPath(env)).toBe(relayLockPath("triage", env));
    expect(TRIAGE_CONSOLE).toBe("triage");
  });

  test("the lock is takeable at the triage path and leaves the review path free", async () => {
    const env = await tempRunsDir();
    assertHermetic(env);
    const held = await acquireTriageActorLock(env);
    expect(held).not.toBeNull();
    // A second triage starter is refused — the exclusion the lock exists for.
    expect(await acquireTriageActorLock(env)).toBeNull();
    // And the review console's starter is NOT, which is §9.13's whole point.
    const { acquireRelayLock } = await import("../../src/run/console-relay.ts");
    const review = await acquireRelayLock(relayLockPath("review", env));
    expect(review).not.toBeNull();
    await review!.release();
    await held!.release();
    // Released means retakeable, not merely absent.
    const again = await acquireTriageActorLock(env);
    expect(again).not.toBeNull();
    await again!.release();
  });
});

// ---------------------------------------------------------------------------
// The record — §7.7's fields, and the `runs`/`run_id` reconciliation §6.6 forced
// ---------------------------------------------------------------------------

describe("the actor record (§7.7)", () => {
  /**
   * The field set asserted BY NAME, so a field cannot be added or dropped in
   * silence — `monitor-readonly.test.ts:363-369`'s lesson, that naming the
   * permitted set is what makes a seventh member fail.
   */
  test("it carries §7.7's seven fields, plus the four the relay record already had", async () => {
    const env = await tempRunsDir();
    const rec = triageActorRecord(identity(env), cursor());
    expect(Object.keys(rec).sort()).toEqual(
      [
        "cadence_s",
        "console",
        "consecutive_skips",
        "log_path",
        "pid",
        "pinned",
        "recycled_at",
        "run_id",
        "runs",
        "schema",
        "started",
        "started_at",
        "sweep_cursor",
        "workers",
      ].sort(),
    );
    expect(rec.console).toBe("triage");
    expect(rec.sweep_cursor).toBe(7);
    expect(rec.consecutive_skips).toBe(0);
    expect(rec.cadence_s).toBe(300);
  });

  /**
   * §6.6: *"§7.7's `run_id` is wrong and becomes `runs`"* — but `RelayRecordSchema`
   * shipped with `run_id` and `servesConsole` compares it, so the two must be
   * reconciled rather than one deleted. `run_id` is DERIVED from the map, which
   * is what makes "the record has two answers to which run" unrepresentable.
   */
  test("`run_id` is the collator's entry in `runs`, by value", async () => {
    const env = await tempRunsDir();
    const rec = triageActorRecord(identity(env), cursor());
    expect(rec.runs["tri-1"]).toBe("r-tri");
    expect(rec.run_id).toBe("r-tri");
    // Asymmetric: the observers' runs are all different, so a builder that took
    // "the first run" or "any run" would pick a wrong one rather than the same one.
    expect(new Set(Object.values(rec.runs)).size).toBe(4);
  });

  /**
   * §6.6's half-recycled console — *"a crash between the second seat and the
   * third"* — must be REPRESENTABLE, or the next boundary reads it as done.
   */
  test("a seat with no run is representable, and an unpinned collator gives an empty `run_id`", async () => {
    const env = await tempRunsDir();
    const half = triageActorRecord(identity(env), cursor({ runs: { "obs-t1": "r-o1" } }));
    expect(half.run_id).toBe("");
    expect(Object.keys(half.runs)).toEqual(["obs-t1"]);
    // `""` names no run, so a starter comparing against a real console adopts
    // nothing — the same fail-closed posture `console: ""` gets.
    expect(servesConsole(half, { name: "triage", runId: "r-tri", workers: [...WORKERS] })).toBe(
      false,
    );
  });

  test("a record whose `run_id` disagrees with `runs` is refused", async () => {
    const env = await tempRunsDir();
    const rec = { ...triageActorRecord(identity(env), cursor()), run_id: "r-somebody-else" };
    const read = parseTriageActorRecord(JSON.stringify(rec), "/x.json");
    expect(read.kind).toBe("refused");
    expect(read.kind === "refused" && read.reason).toContain("run_id");
  });

  test("a run for a seat this console does not have is refused", async () => {
    const env = await tempRunsDir();
    const rec = triageActorRecord(identity(env), cursor());
    const bad = { ...rec, runs: { ...rec.runs, "col-1": "r-review" } };
    const read = parseTriageActorRecord(JSON.stringify(bad), "/x.json");
    expect(read.kind).toBe("refused");
    expect(read.kind === "refused" && read.reason).toContain("col-1");
  });

  /**
   * §6.6 layer 4's per-seat clock, and the ONE asymmetry that makes the resume
   * work: a seat may carry a stamp while carrying no run.
   *
   * That pair IS the half-recycled console — `down` succeeded, `up` had not run
   * when the actor died — so a schema that required `recycled_at`'s keys to be a
   * subset of `runs`' would make the state §6.6 exists to recover unrepresentable.
   */
  test("a stamp for a seat with no run is legal; a stamp for a foreign seat is refused", async () => {
    const env = await tempRunsDir();
    const base = triageActorRecord(identity(env), cursor());
    const halfRecycled = {
      ...base,
      runs: { "tri-1": "r-tri" },
      run_id: "r-tri",
      recycled_at: { "tri-1": 100, "obs-t2": 40 },
    };
    expect(parseTriageActorRecord(JSON.stringify(halfRecycled), "/x.json").kind).toBe("ok");
    const foreign = { ...base, recycled_at: { "col-1": 3 } };
    const read = parseTriageActorRecord(JSON.stringify(foreign), "/x.json");
    expect(read.kind).toBe("refused");
    expect(read.kind === "refused" && read.reason).toContain("col-1");
    // And an absent map is the ordinary state of a console that has never
    // recycled, not a refusal.
    const { recycled_at: _dropped, ...without } = base;
    const legacy = parseTriageActorRecord(JSON.stringify(without), "/x.json");
    expect(legacy.kind).toBe("ok");
    expect(legacy.kind === "ok" && legacy.record.recycled_at).toBeUndefined();
    // And the one WRITER always emits it, so a record this build produced never
    // reaches a reader in that shape — a cursor with no clock still writes `{}`.
    expect(base.recycled_at).toEqual({});
    expect(triageActorRecord(identity(env), cursor({ recycled_at: { "tri-1": 9 } })).recycled_at)
      .toEqual({ "tri-1": 9 });
  });

  test("a record naming the OTHER console is refused", async () => {
    const env = await tempRunsDir();
    const rec = { ...triageActorRecord(identity(env), cursor()), console: "review" };
    const read = parseTriageActorRecord(JSON.stringify(rec), "/x.json");
    expect(read.kind).toBe("refused");
    expect(read.kind === "refused" && read.reason).toContain("review");
  });

  /**
   * THE COMPATIBILITY CLAIM, and it is load-bearing rather than incidental.
   *
   * The triage actor's record is a `RelayRecord` PLUS §7.7's four fields, and it
   * keeps `pifleet.consolerelay/v1` deliberately: `readRelayStatus` is what
   * `scripts/triage --actor-stop` and any future manager use to decide whether the
   * recorded process is alive, and a record they answer `unreadable` for is one
   * that — correctly — *"never licenses a signal"*. A private schema literal
   * would make every triage actor unstoppable by the fleet's own reader.
   */
  test("`readRelayStatus` reads it, and `servesConsole` adopts it for triage alone", async () => {
    const env = await tempRunsDir();
    assertHermetic(env);
    const rec = triageActorRecord(identity(env), cursor());
    await writeTriageActorRecord(triageActorRecordPath(env), rec);
    const status = await readRelayStatus(triageActorRecordPath(env));
    // `stale`, not `unreadable`: the extra fields are dropped by the relay
    // schema rather than refused by it, and the invented start time is what
    // makes the verdict `stale` rather than `live`.
    expect(status.kind).toBe("stale");
    expect(RelayRecordSchema.safeParse(rec).success).toBe(true);
    expect(servesConsole(rec, { name: "triage", runId: "r-tri", workers: [...WORKERS] })).toBe(true);
    expect(servesConsole(rec, { name: "review", runId: "r-tri", workers: [...WORKERS] })).toBe(
      false,
    );
  });

  test("it round-trips through the disk at the triage path", async () => {
    const env = await tempRunsDir();
    assertHermetic(env);
    const rec = triageActorRecord(identity(env), cursor({ sweep_cursor: 41, consecutive_skips: 2 }));
    await writeTriageActorRecord(triageActorRecordPath(env), rec);
    const read = await readTriageActorRecord(env);
    expect(read.kind).toBe("ok");
    expect(read.kind === "ok" && read.record).toEqual(rec);
    expect(read.kind === "ok" && read.record.sweep_cursor).toBe(41);
    expect(read.kind === "ok" && read.record.consecutive_skips).toBe(2);
  });

  /**
   * A file can be hand-edited or truncated by a crash mid-write, and neither is
   * a reason to END the actor's loop — `parseIncidentRecord`'s posture, taken
   * rather than re-argued.
   */
  test("a malformed record REFUSES rather than throwing", async () => {
    expect(parseTriageActorRecord("{not json", "/x.json").kind).toBe("refused");
    expect(parseTriageActorRecord("[]", "/x.json").kind).toBe("refused");
    expect(parseTriageActorRecord("null", "/x.json").kind).toBe("refused");
    expect(parseTriageActorRecord("{}", "/x.json").kind).toBe("refused");
  });

  test("an absent record is `absent`, which is not the same as malformed", async () => {
    const env = await tempRunsDir();
    expect((await readTriageActorRecord(env)).kind).toBe("absent");
  });

  test("writing a record the schema refuses throws rather than persisting it", async () => {
    const env = await tempRunsDir();
    assertHermetic(env);
    const bad = { ...triageActorRecord(identity(env), cursor()), sweep_cursor: -1 };
    await expect(writeTriageActorRecord(triageActorRecordPath(env), bad)).rejects.toThrow();
    expect((await readTriageActorRecord(env)).kind).toBe("absent");
  });
});

// ---------------------------------------------------------------------------
// The log — §7.7's "appended, never truncated", which is why ISC-710 exists
// ---------------------------------------------------------------------------

describe("the actor log is append-only and carries nothing it should not (§7.7)", () => {
  test("a second append does not lose the first", async () => {
    const env = await tempRunsDir();
    assertHermetic(env);
    const path = triageActorLogPath(env);
    await appendActorLog(path, { kind: "actor_started", pid: 1, run_id: "r-tri", cadence_s: 300 }, 0);
    const afterOne = (await stat(path)).size;
    await appendActorLog(path, { kind: "actor_stopped", passes: 3 }, 1);
    const text = await readFile(path, "utf8");
    expect(text).toContain("actor_started");
    expect(text).toContain("actor_stopped");
    expect(text.trimEnd().split("\n")).toHaveLength(2);
    // The file GREW. A `writeFile` implementation leaves two lines' worth of
    // content in a file that is smaller than it was, and the line count alone
    // cannot see that when the second line is longer than the first.
    expect((await stat(path)).size).toBeGreaterThan(afterOne);
  });

  test("n appends leave n lines, in order", async () => {
    const env = await tempRunsDir();
    const path = triageActorLogPath(env);
    for (let i = 0; i < 12; i += 1) {
      await appendActorLog(path, { kind: "actor_stopped", passes: i }, i);
    }
    const lines = (await readFile(path, "utf8")).trimEnd().split("\n");
    expect(lines).toHaveLength(12);
    expect(lines[0]).toContain("passes=0");
    expect(lines[11]).toContain("passes=11");
  });

  /**
   * ONE EVENT IS ONE LINE, whatever the free text does.
   *
   * The log is a file an operator greps and a future reader may parse. A newline
   * inside a reason is a forged second record, and the reason is the one field
   * on this union that is not host-minted — it is an exception message, so its
   * content is whatever threw.
   */
  test("a reason full of newlines and control bytes is still exactly one line", async () => {
    const env = await tempRunsDir();
    const path = triageActorLogPath(env);
    await appendActorLog(
      path,
      { kind: "pass_failed", reason: "boom\nkind=console_gone worker=tri-1\r\n\u0000evil" },
      0,
    );
    const text = await readFile(path, "utf8");
    expect(text.trimEnd().split("\n")).toHaveLength(1);
    // The injected text survives as DATA on the one line rather than vanishing,
    // so a redaction is visible rather than silent — `sanitizeToken`'s rule.
    expect(text).toContain("boom");
    expect(text).toMatch(/^[\x20-\x7e]+\n$/);
  });

  test("a very long reason is capped rather than written whole", async () => {
    const env = await tempRunsDir();
    const path = triageActorLogPath(env);
    await appendActorLog(path, { kind: "pass_failed", reason: "x".repeat(50_000) }, 0);
    const text = await readFile(path, "utf8");
    expect(text.length).toBeLessThan(2_000);
    expect(text).toContain("...");
  });

  /**
   * §7.7's log appends and is never truncated, so **a credential written there is
   * a credential forever** — ISC-710's hazard, and the reason this union is
   * CLOSED rather than an open record of strings.
   *
   * The structural guarantee is that no arm has a field a credential could travel
   * in: no `headers`, no `request`, no `url`, no `token`, no `authorization`. A
   * seventh arm that added one is a red test here, which is what makes the
   * guarantee a property of the type rather than of the next author's care.
   */
  test("the event union is closed, and no arm can carry a credential", () => {
    expect([...TRIAGE_ACTOR_EVENT_KINDS].sort()).toEqual([
      "actor_refused",
      "actor_started",
      "actor_stopped",
      "actor_unsupervised",
      "boundary_unreadable",
      "budget_halted",
      "budget_unaccounted",
      "console_gone",
      "console_unobservable",
      "pass_completed",
      "pass_failed",
      "record_write_failed",
      "recycle_failed",
      "seat_recycled",
      "sweep_withheld",
    ]);
    const sample: TriageActorEvent[] = [
      { kind: "actor_started", pid: 1, run_id: "r-tri", cadence_s: 300 },
      { kind: "actor_refused", reason: "somebody holds the lock" },
      { kind: "actor_unsupervised" },
      /*
       * §13 task 6.8's two arms, and the field names are the point.
       * `BudgetState` spells these `tokens_spent`/`tokens_ceiling`; copying that
       * spelling here fails the loop below, because `token` is on the banned list
       * and this check cannot tell a token COUNT from an auth token. It is not
       * meant to — see the arm's own docblock.
       */
      { kind: "budget_halted", run_id: "r-tri", spent: 6_000_001, ceiling: 6_000_000, degraded: [] },
      { kind: "budget_unaccounted", reason: "run.json will not parse" },
      { kind: "pass_completed", sweep_cursor: 4, consecutive_skips: 1 },
      { kind: "pass_failed", reason: "boom" },
      { kind: "record_write_failed", reason: "ENOSPC" },
      { kind: "console_unobservable", worker: "tri-1", reason: "ps under load" },
      { kind: "console_gone", worker: "tri-1", run_id: "r-tri", passes: 5 },
      { kind: "boundary_unreadable", reason: "runs root is not readable" },
      { kind: "seat_recycled", worker: "obs-t2", sweep_cursor: 96 },
      { kind: "recycle_failed", worker: "obs-t2", reason: "no image" },
      { kind: "sweep_withheld", seats: ["obs-t2"] },
      { kind: "actor_stopped", passes: 9 },
    ];
    expect(sample.map((e) => e.kind).sort()).toEqual([...TRIAGE_ACTOR_EVENT_KINDS].sort());
    const banned = ["header", "request", "url", "token", "auth", "secret", "endpoint", "env"];
    for (const event of sample) {
      for (const field of Object.keys(event)) {
        for (const word of banned) {
          expect(field.toLowerCase().includes(word), `${event.kind}.${field}`).toBe(false);
        }
      }
    }
  });

  /**
   * The four arms §6.6 layer 4 and §6.3b added, rendered — because an arm with
   * no `rest` renders a line ending in a space and a field an operator cannot
   * grep for. Every one of them is a fact the console's own recovery depends on.
   */
  test("the recycle, the gate and the refusal all render as greppable fields", () => {
    expect(actorLogLine({ kind: "seat_recycled", worker: "obs-t2", sweep_cursor: 96 }, 0)).toContain(
      "worker=obs-t2 sweep=96",
    );
    expect(actorLogLine({ kind: "sweep_withheld", seats: ["obs-t2", "obs-t3"] }, 0)).toContain(
      "seats=obs-t2,obs-t3",
    );
    expect(actorLogLine({ kind: "actor_unsupervised" }, 0)).toContain("ports=absent");
    expect(
      actorLogLine(
        {
          kind: "budget_halted",
          run_id: "r-tri",
          spent: 6_000_001,
          ceiling: 6_000_000,
          degraded: ["obs-t2"],
        },
        0,
      ),
    ).toContain("run=r-tri spent=6000001 ceiling=6000000 degraded=obs-t2");
    // An unbounded run says so rather than rendering `ceiling=null`, which reads
    // as a missing value in a grep rather than as the fact that nobody budgeted.
    expect(
      actorLogLine(
        { kind: "budget_halted", run_id: "r-tri", spent: 1, ceiling: null, degraded: [] },
        0,
      ),
    ).toContain("ceiling=unbounded");
    expect(actorLogLine({ kind: "actor_refused", reason: "held by 42" }, 0)).toContain(
      'reason="held by 42"',
    );
    expect(actorLogLine({ kind: "recycle_failed", worker: "obs-t1", reason: "no image" }, 0)).toContain(
      'worker=obs-t1 reason="no image"',
    );
    expect(actorLogLine({ kind: "boundary_unreadable", reason: "EIO" }, 0)).toContain('reason="EIO"');
    // Still one line each, whatever the free text does.
    for (const e of [
      { kind: "sweep_withheld", seats: ["a\nb"] } as const,
      { kind: "actor_refused", reason: "a\nb" } as const,
    ]) {
      expect(actorLogLine(e, 0).split("\n")).toHaveLength(1);
    }
  });

  test("every line names the clock, the console and the kind", () => {
    const line = actorLogLine({ kind: "console_gone", worker: "tri-1", run_id: "r-x", passes: 5 }, 0);
    expect(line.startsWith("1970-01-01T00:00:00.000Z ")).toBe(true);
    expect(line).toContain("triage-actor");
    expect(line).toContain("kind=console_gone");
    expect(line).toContain("worker=tri-1");
    expect(line).toContain("run=r-x");
    expect(line).toContain("passes=5");
  });
});

// ---------------------------------------------------------------------------
// THE WATCH — §13 task 6.3's acceptance, both halves
// ---------------------------------------------------------------------------

describe("the watched seat is the roster's, not a literal typed twice", () => {
  /**
   * `triage-actor.ts` does not import `dispatch-request.ts`: that module reaches
   * `relay.ts` for `isCollationTaskId`, and dragging the whole fan-out into the
   * actor's import closure is the shape §12's read-only guard (task 6.6) is
   * written against. So the collator is named here and the agreement is closed by
   * a TEST — `console-relay.test.ts`'s own answer to two lists that must agree,
   * and `task-ids.ts`'s reason for duplicating a constant rather than importing
   * one.
   */
  test("TRIAGE_COLLATOR is exactly the triage roster's collator", () => {
    expect(TRIAGE_CONSOLE_ROSTER.collators).toEqual([TRIAGE_COLLATOR]);
    expect(TRIAGE_COLLATOR).toBe("tri-1");
  });
});

describe("the actor exits when its console is gone (§12, §6.4, §9 Q4)", () => {
  test("`tri-1` not live for RELAY_ABANDON_PASSES passes ends the loop, and the log says why", async () => {
    const h = harness({
      live: Array.from({ length: RELAY_ABANDON_PASSES }, () => false),
      maxPasses: RELAY_ABANDON_PASSES + 5,
    });
    const exit = await runTriageActor(h.deps, {
      cadenceS: 300,
      runId: "r-tri",
      signal: h.signal,
    });

    // THE PREMISE, one step earlier: the loop actually ran and actually asked.
    // A loop that returned on its first line satisfies the exit assertion below
    // and asks nothing, and a comment cannot go red.
    expect(h.counts().probes).toBe(RELAY_ABANDON_PASSES);
    expect(h.counts().passes).toBe(RELAY_ABANDON_PASSES);
    // It exited on the WATCH, not on the harness's abort bound.
    expect(h.sleeps.length).toBeLessThan(RELAY_ABANDON_PASSES + 5);

    expect(exit.kind).toBe("console_gone");
    expect(exit.kind === "console_gone" && exit.worker).toBe("tri-1");
    expect(exit.kind === "console_gone" && exit.passes).toBe(RELAY_ABANDON_PASSES);

    // THE REASON, on both surfaces §12 asks for. The sentence travels on the
    // exit for the caller's stderr (task 6.2) and names all three facts; the log
    // carries the same three as fields, because a log line that never shrinks
    // should hold data rather than prose.
    const reason = exit.kind === "console_gone" ? exit.reason : "";
    expect(reason).toContain("tri-1");
    expect(reason).toContain("r-tri");
    expect(reason).toContain(`${RELAY_ABANDON_PASSES} consecutive passes`);

    const gone = h.spy.events.filter((e) => e.kind === "console_gone");
    expect(gone).toHaveLength(1);
    expect(gone[0]).toEqual({
      kind: "console_gone",
      worker: "tri-1",
      run_id: "r-tri",
      passes: RELAY_ABANDON_PASSES,
    });
  });

  /**
   * THE CONTROL, and it is what stops the criterion being met by an actor that
   * simply exits. Identical harness, identical bound, one bit changed.
   */
  test("a live console is never abandoned, and the same harness proves it", async () => {
    const h = harness({
      live: Array.from({ length: RELAY_ABANDON_PASSES + 5 }, () => true),
      maxPasses: RELAY_ABANDON_PASSES + 5,
    });
    const exit = await runTriageActor(h.deps, {
      cadenceS: 300,
      runId: "r-tri",
      signal: h.signal,
    });
    expect(exit.kind).toBe("stopped");
    expect(h.counts().probes).toBe(RELAY_ABANDON_PASSES + 5);
    expect(h.spy.events.some((e) => e.kind === "console_gone")).toBe(false);
  });

  /**
   * THE MIRROR — §12's second half, and the half that stops the watch being
   * satisfiable by something that exits a lot.
   *
   * Four negatives, one positive, four more negatives. That is EIGHT negatives
   * against a tolerance of five, so an implementation that summed isolated
   * failures rather than requiring a run has already exited by the time the ninth
   * observation is made. Liveness is read from a state file and a `ps`, both of
   * which fail transiently, and an actor whose lifetime depends on that race is
   * one the operator cannot keep alive.
   */
  test("a run of negatives broken by ONE positive does not reap a healthy actor", async () => {
    const n = RELAY_ABANDON_PASSES - 1;
    const scripted = [
      ...Array.from({ length: n }, () => false),
      true,
      ...Array.from({ length: n }, () => false),
    ];
    const h = harness({ live: scripted, maxPasses: scripted.length });
    const exit = await runTriageActor(h.deps, {
      cadenceS: 300,
      runId: "r-tri",
      signal: h.signal,
    });
    // The premise: every scripted observation was made, so the fixture really
    // did put 2n negatives past a tolerance of n+1.
    expect(h.counts().probes).toBe(scripted.length);
    expect(scripted.filter((x) => !x).length).toBeGreaterThan(RELAY_ABANDON_PASSES);
    expect(exit.kind).toBe("stopped");
    expect(h.spy.events.some((e) => e.kind === "console_gone")).toBe(false);
  });

  /**
   * The mirror's other direction: the streak resumes from ZERO, so the run after
   * the positive must be a FULL tolerance long. Asserting the pass count by value
   * is what separates "reset to 0" from "reset to 1" — an off-by-one that leaves
   * the actor reaped one pass early and is invisible to a boolean assertion.
   */
  test("after a positive the count restarts at zero, asserted by value", async () => {
    const n = RELAY_ABANDON_PASSES - 1;
    const scripted = [
      ...Array.from({ length: n }, () => false),
      true,
      ...Array.from({ length: RELAY_ABANDON_PASSES }, () => false),
    ];
    const h = harness({ live: scripted, maxPasses: scripted.length + 5 });
    const exit = await runTriageActor(h.deps, {
      cadenceS: 300,
      runId: "r-tri",
      signal: h.signal,
    });
    expect(exit.kind).toBe("console_gone");
    // Exactly the whole script: not one pass earlier (a streak that never reset,
    // or reset to 1) and not one later.
    expect(exit.kind === "console_gone" && exit.passes).toBe(scripted.length);
    expect(h.counts().probes).toBe(scripted.length);
  });

  /**
   * THE DIVERGENCE FROM `relay.ts`, stated as a test because it is a decision.
   *
   * `cli/commands/relay.ts:951-963` observes liveness INSIDE the try that wraps
   * the pass, so a pass that throws skips the observation entirely. On this
   * console that is the wrong way round: a console that has gone away is the most
   * likely reason for the pass to throw, so the actor whose console died would be
   * exactly the actor that never notices.
   */
  test("a pass that throws every time does not stop the watch from reaping", async () => {
    const h = harness({
      live: Array.from({ length: RELAY_ABANDON_PASSES }, () => false),
      maxPasses: RELAY_ABANDON_PASSES + 5,
      pass: async () => {
        throw new Error("the fan-out found no live seat");
      },
    });
    const exit = await runTriageActor(h.deps, {
      cadenceS: 300,
      runId: "r-tri",
      signal: h.signal,
    });
    expect(exit.kind).toBe("console_gone");
    expect(h.spy.events.filter((e) => e.kind === "pass_failed")).toHaveLength(
      RELAY_ABANDON_PASSES,
    );
  });

  /**
   * `relay.ts:700-723`'s measured property, on this console: *"any throw ENDED
   * the actor"*, and nothing restarts one.
   */
  test("a single thrown pass is logged and the loop continues", async () => {
    const h = harness({
      live: [true, true, true],
      maxPasses: 3,
      pass: async (n) => {
        if (n === 1) throw new Error("transient");
        return cursor();
      },
    });
    const exit = await runTriageActor(h.deps, { cadenceS: 300, runId: "r-tri", signal: h.signal });
    expect(exit.kind).toBe("stopped");
    expect(h.counts().passes).toBe(3);
    const failed = h.spy.events.filter((e) => e.kind === "pass_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual({ kind: "pass_failed", reason: "transient" });
  });

  /**
   * A BROKEN INSTRUMENT IS NOT A NEGATIVE OBSERVATION.
   *
   * `readRelayStatus`'s `unverifiable` posture, applied to the watch: *"the
   * caller must neither adopt it as this console's nor tear it down."* The
   * production probe swallows its own errors and answers `false`
   * (`relay.ts:3432-3444`), so this arm is unreachable through it TODAY — but the
   * probe is injected, and an injected one that throws must not reap the actor
   * either. The alternative readings both fail: mapping a throw to `false` reaps
   * a healthy actor after five broken `ps` calls, and mapping it to `true` makes
   * an actor with a permanently broken probe immortal.
   */
  test("a liveness probe that THROWS neither advances nor resets the streak", async () => {
    const n = RELAY_ABANDON_PASSES - 1;
    let probe = 0;
    const h = harness({
      live: [],
      maxPasses: n + 3 + 1,
      probe: async () => {
        probe += 1;
        // n negatives, then three broken reads, then one more negative.
        if (probe <= n) return false;
        if (probe <= n + 3) throw new Error("ps: could not be read");
        return false;
      },
    });
    const exit = await runTriageActor(h.deps, { cadenceS: 300, runId: "r-tri", signal: h.signal });
    // The broken reads neither reaped it early (they are not negatives) nor
    // saved it (they are not positives): the very next negative is the fifth.
    expect(exit.kind).toBe("console_gone");
    expect(exit.kind === "console_gone" && exit.passes).toBe(n + 3 + 1);
    expect(h.spy.events.filter((e) => e.kind === "console_unobservable")).toHaveLength(3);
  });

  test("the loop waits the configured cadence between passes, in milliseconds", async () => {
    const h = harness({ live: [true, true], maxPasses: 2 });
    await runTriageActor(h.deps, { cadenceS: 300, runId: "r-tri", signal: h.signal });
    expect(h.sleeps).toEqual([300_000, 300_000]);
  });

  test("an already-aborted signal runs no pass at all", async () => {
    const h = harness({ live: [true], maxPasses: 1 });
    const controller = new AbortController();
    controller.abort();
    const exit = await runTriageActor(h.deps, {
      cadenceS: 300,
      runId: "r-tri",
      signal: controller.signal,
    });
    expect(exit.kind).toBe("stopped");
    expect(h.counts().passes).toBe(0);
    expect(h.counts().probes).toBe(0);
  });

  /**
   * The record is a CURSOR and the run tree is authoritative (D12), so a record
   * that cannot be written is not a reason to end the actor — but it IS a reason
   * to say so on the one surface guaranteed to work.
   */
  test("a record write that fails is logged and does not end the actor", async () => {
    const h = harness({ live: [true, true], maxPasses: 2 });
    const deps: TriageActorDeps = {
      ...h.deps,
      saveCursor: async () => {
        throw new Error("ENOSPC");
      },
    };
    const exit = await runTriageActor(deps, { cadenceS: 300, runId: "r-tri", signal: h.signal });
    expect(exit.kind).toBe("stopped");
    expect(h.spy.events.filter((e) => e.kind === "record_write_failed")).toHaveLength(2);
  });

  test("the pass's cursor is what reaches the record, unchanged", async () => {
    const saved: TriageActorCursor[] = [];
    const h = harness({
      live: [true],
      maxPasses: 1,
      pass: async () => cursor({ sweep_cursor: 99, consecutive_skips: 2 }),
    });
    const deps: TriageActorDeps = {
      ...h.deps,
      saveCursor: async (c) => {
        saved.push(c);
      },
    };
    await runTriageActor(deps, { cadenceS: 300, runId: "r-tri", signal: h.signal });
    /*
     * `recycled_at: {}` is the ACTOR's field and the only one it adds — the pass
     * owns the other three and they arrive byte for byte. Before §13 task 6.5b
     * made `ports` required an un-ported actor passed the cursor through
     * untouched; now every actor has a clock, and an empty one is what a console
     * with no seats has recycled.
     */
    expect(saved).toEqual([
      { runs: fourRuns(), sweep_cursor: 99, consecutive_skips: 2, recycled_at: {} },
    ]);
  });

  /**
   * A recycle (task 6.5) mints new runs mid-life, so the run the actor was
   * STARTED for stops being the run it is watching. The abandonment message must
   * name the run the console is in NOW, or an operator reading the log is sent to
   * a run id that has not existed for hours.
   */
  test("the abandonment names the collator's CURRENT run, not the one it started with", async () => {
    const h = harness({
      live: [true, ...Array.from({ length: RELAY_ABANDON_PASSES }, () => false)],
      maxPasses: RELAY_ABANDON_PASSES + 3,
      pass: async () => cursor({ runs: { ...fourRuns(), "tri-1": "r-recycled" } }),
    });
    const exit = await runTriageActor(h.deps, {
      cadenceS: 300,
      runId: "r-tri-at-start",
      signal: h.signal,
    });
    expect(exit.kind).toBe("console_gone");
    expect(exit.kind === "console_gone" && exit.run_id).toBe("r-recycled");
  });

  test("the log's first line is the actor announcing itself", async () => {
    const h = harness({ live: [true], maxPasses: 1 });
    await runTriageActor(h.deps, { cadenceS: 300, runId: "r-tri", signal: h.signal });
    expect(h.spy.events[0]).toEqual({
      kind: "actor_started",
      pid: process.pid,
      run_id: "r-tri",
      cadence_s: 300,
    });
  });
});

// ---------------------------------------------------------------------------
// The schema's own bounds
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// §6.6 layer 4's BOUNDARY, as a pure function — §13 task 6.5
// ---------------------------------------------------------------------------

describe("the recycle boundary is per SEAT, not per console (§6.6 layer 4)", () => {
  const seats = [...WORKERS];

  /**
   * §6.6: *"it asks, of each seat, 'is this seat's run older than
   * `recycle_after_sweeps`, or absent'"* — the two clauses, separately, so a
   * reading that collapsed them into one cannot pass.
   */
  test("a seat whose run is ABSENT is due, whatever its stamp says", () => {
    const { due } = seatsDueForRecycle({
      seats,
      // `obs-t2` crashed between its `down` and its `up`, so it has no pin —
      // and its stamp is RECENT, which is what makes this clause independent.
      runs: { "tri-1": "r-a", "obs-t1": "r-b", "obs-t3": "r-c" },
      stamps: { ...ALL_FRESH },
      sweepCursor: 100,
      recycleAfterSweeps: 48,
    });
    expect(due).toEqual(["obs-t2"]);
  });

  test("a seat whose run is older than the window is due, and a fresh one is not", () => {
    const stamps = { "tri-1": 40, "obs-t1": 52, "obs-t2": 51, "obs-t3": 100 };
    // The premise, by value: the four seats are at four DIFFERENT ages, so a
    // decision that answered "all" or "none" cannot pass by coincidence.
    expect(new Set(Object.values(stamps)).size).toBe(4);
    const { due } = seatsDueForRecycle({
      seats,
      runs: fourRuns(),
      stamps,
      sweepCursor: 100,
      recycleAfterSweeps: 48,
    });
    // 100−40 = 60 ≥ 48 and 100−52 = 48 ≥ 48; 100−51 = 49 ≥ 48; 100−100 = 0.
    expect(due).toEqual(["tri-1", "obs-t1", "obs-t2"]);
  });

  /**
   * THE CLAUSE THE RESUME CRITERION FORCES.
   *
   * A pinned seat the actor has never stamped is stamped at the CURRENT cursor
   * and is not due. The alternative reading — "unknown age means due" — makes
   * every restart recycle the whole console, which is precisely the *"restarted
   * rather than completed"* failure §6.6's resolution is written against.
   */
  test("a pinned seat with no stamp is stamped now rather than recycled", () => {
    const { due, stamps } = seatsDueForRecycle({
      seats,
      runs: fourRuns(),
      stamps: {},
      sweepCursor: 100,
      recycleAfterSweeps: 48,
    });
    expect(due).toEqual([]);
    expect(stamps).toEqual({ "tri-1": 100, "obs-t1": 100, "obs-t2": 100, "obs-t3": 100 });
  });

  /**
   * §7.8: *"`0` disables"* — the AGE clause, and only that one.
   *
   * An absent pin is not a freshness decision; it is a half-recycled console,
   * and §6.6 admits no sweep while one exists. A `0` that disabled the absent
   * clause too would leave that console wedged forever with the sweep gate shut
   * and nothing allowed to repair it — a disable knob that turns into a deadlock.
   */
  test("`recycle_after_sweeps: 0` stops the clock but still repairs an absent pin", () => {
    const aged = seatsDueForRecycle({
      seats,
      runs: fourRuns(),
      stamps: { ...ALL_STALE },
      sweepCursor: 100,
      recycleAfterSweeps: 0,
    });
    expect(aged.due).toEqual([]);
    const absent = seatsDueForRecycle({
      seats,
      runs: { "tri-1": "r-a", "obs-t1": "r-b", "obs-t3": "r-c" },
      stamps: { ...ALL_STALE },
      sweepCursor: 100,
      recycleAfterSweeps: 0,
    });
    expect(absent.due).toEqual(["obs-t2"]);
  });

  /** A record from the future cannot make a seat due by going backwards. */
  test("a stamp ahead of the cursor is not due", () => {
    const { due } = seatsDueForRecycle({
      seats,
      runs: fourRuns(),
      stamps: { "tri-1": 500, "obs-t1": 500, "obs-t2": 500, "obs-t3": 500 },
      sweepCursor: 100,
      recycleAfterSweeps: 48,
    });
    expect(due).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §6.6 layer 4 in the LOOP — §13 task 6.5's five acceptance clauses
// ---------------------------------------------------------------------------

describe("the actor recycles between sweeps and never during one (§6.6 layer 4, §9.11)", () => {
  /**
   * §9.11: *"A recycle is due while a sweep is in flight → the recycle waits;
   * nothing is torn down."* This fixture and the next differ in ONE BIT.
   */
  test("the in-flight fixture recycles nothing", async () => {
    const h = harness({ live: [true], maxPasses: 1 });
    const p = recyclePorts({ runs: [fourRuns()], inFlight: true, resume: resumed() });
    // THE PREMISE: every seat really is due, so "recycled nothing" is a decision
    // rather than an empty input. A fixture with nothing due passes vacuously.
    expect(
      seatsDueForRecycle({
        seats: [...WORKERS],
        runs: fourRuns(),
        stamps: { ...ALL_STALE },
        sweepCursor: 100,
        recycleAfterSweeps: 48,
      }).due,
    ).toEqual([...WORKERS]);

    const exit = await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(exit.kind).toBe("stopped");
    expect(p.downs).toEqual([]);
    expect(p.ups).toEqual([]);
    // And the sweep still happened: the recycle waited, the console did not stop.
    expect(h.counts().passes).toBe(1);
  });

  test("the idle fixture recycles all four, down-then-up, seat by seat", async () => {
    const h = harness({ live: [true], maxPasses: 1 });
    const order: string[] = [];
    const p = recyclePorts({
      runs: [fourRuns(), fourRuns()],
      inFlight: false,
      resume: resumed(),
      downSeat: async (s) => {
        order.push(`down ${s}`);
      },
      upSeat: async (s) => {
        order.push(`up ${s}`);
      },
    });
    const exit = await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(exit.kind).toBe("stopped");
    expect(order).toEqual([
      "down tri-1",
      "up tri-1",
      "down obs-t1",
      "up obs-t1",
      "down obs-t2",
      "up obs-t2",
      "down obs-t3",
      "up obs-t3",
    ]);
    // §6.6: four `down`s and four `up`s, not a four-way pane dance.
    expect(order.filter((s) => s.startsWith("down "))).toHaveLength(4);
    expect(order.filter((s) => s.startsWith("up "))).toHaveLength(4);
  });

  /**
   * §13: *"the sweep counter continues rather than resetting"*. §6.6 layer 2's
   * whole guarantee is that no sweep ever reuses an id, and a recycle that reset
   * the counter would mint `T-sweep-1` into a console the epoch fence has already
   * seen — which `triage-pass.ts:449-461` measured as a sweep that silently does
   * nothing.
   */
  test("the sweep counter continues across a recycle rather than resetting", async () => {
    const saved: TriageActorCursor[] = [];
    const h = harness({
      live: [true],
      maxPasses: 1,
      pass: async () => cursor({ sweep_cursor: 137, consecutive_skips: 2 }),
    });
    const p = recyclePorts({ runs: [fourRuns(), fourRuns()], resume: resumed() });
    await runTriageActor(
      {
        ...h.deps,
        ports: p.ports,
        saveCursor: async (c) => {
          saved.push(c);
        },
      },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(p.downs).toEqual([...WORKERS]);
    // TWO writes, and each one is a different fact. The first is the recycle's
    // own — **persisted before the pass runs**, because an actor that crashed
    // between the recycle and its first sweep would otherwise come back with the
    // clock it started with and recycle the same four seats again.
    expect(saved).toHaveLength(2);
    expect(saved[0]!.sweep_cursor).toBe(100);
    expect(saved[0]!.recycled_at).toEqual(ALL_FRESH);
    // And not one of the writes is a reset.
    expect(saved.some((c) => c.sweep_cursor === 0)).toBe(false);
    expect(saved.at(-1)!.sweep_cursor).toBe(137);
    expect(saved.at(-1)!.consecutive_skips).toBe(2);
    // The recycle re-stamped every seat at the cursor it recycled AT, which is
    // the resumed record's number — the boundary ran before this pass's own.
    expect(saved.at(-1)!.recycled_at).toEqual(ALL_FRESH);
  });

  /**
   * **THE RESUME CRITERION** — §13: *"a fixture interrupted after two seats is
   * completed by the next boundary rather than restarted, asserted by naming the
   * two seats it did NOT touch again"*.
   *
   * ## The degenerate fixture this is written against
   *
   * A four-seat fixture whose seats look alike **cannot tell "completed the
   * remaining two" from "restarted all four"** — both leave four healthy seats and
   * a happy console. So the four seats here are in four DISTINGUISHABLE states and
   * the premise is asserted a step earlier, by value:
   *
   * | seat | pin | stamp | why |
   * |---|---|---|---|
   * | `tri-1` | `r-new-tri` | 100 | recycled before the crash |
   * | `obs-t1` | `r-new-o1` | 100 | recycled before the crash |
   * | `obs-t2` | **absent** | 40 | crashed BETWEEN its `down` and its `up` |
   * | `obs-t3` | `r-old-o3` | 40 | never reached |
   */
  test("a recycle interrupted after two seats is completed, not restarted", async () => {
    const interruptedPins = {
      "tri-1": "r-new-tri",
      "obs-t1": "r-new-o1",
      "obs-t3": "r-old-o3",
    } as const;
    const interruptedStamps = { "tri-1": 100, "obs-t1": 100, "obs-t2": 40, "obs-t3": 40 };
    const healed = { ...interruptedPins, "obs-t2": "r-new-o2", "obs-t3": "r-new-o3" };

    // THE PREMISE, one step earlier and by value: two seats are already done,
    // one is mid-recycle with no pin at all, and one has never been touched.
    expect(Object.keys(interruptedPins).includes("obs-t2")).toBe(false);
    expect(interruptedStamps["tri-1"]).toBe(100);
    expect(interruptedStamps["obs-t1"]).toBe(100);
    expect(interruptedStamps["obs-t3"]).toBe(40);
    expect(new Set(Object.values(interruptedPins)).size).toBe(3);

    const h = harness({ live: [true], maxPasses: 1 });
    const p = recyclePorts({
      runs: [interruptedPins, healed],
      resume: resumed({ runs: { ...interruptedPins }, recycled_at: interruptedStamps }),
    });
    const exit = await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(exit.kind).toBe("stopped");

    // FINISHED: exactly the two seats the crash left behind.
    expect(p.downs).toEqual(["obs-t2", "obs-t3"]);
    expect(p.ups).toEqual(["obs-t2", "obs-t3"]);
    // NOT RESTARTED, named: the two the interrupted run already did.
    expect(p.downs).not.toContain("tri-1");
    expect(p.downs).not.toContain("obs-t1");
    expect(p.ups).not.toContain("tri-1");
    expect(p.ups).not.toContain("obs-t1");
    expect(p.downs).toHaveLength(2);

    const recycled = h.spy.events.filter((e) => e.kind === "seat_recycled");
    expect(recycled.map((e) => (e.kind === "seat_recycled" ? e.worker : ""))).toEqual([
      "obs-t2",
      "obs-t3",
    ]);
  });

  /**
   * THE ANTI-TWIN of the resume criterion, and it is what stops it being met by
   * an actor that recycles nothing. Same seats, same window, same cursor — the
   * ONE change is that no seat was recycled before the crash.
   */
  test("the same fixture with nothing already done recycles all four", async () => {
    const h = harness({ live: [true], maxPasses: 1 });
    const p = recyclePorts({
      runs: [fourRuns(), fourRuns()],
      resume: resumed({ recycled_at: { ...ALL_STALE } }),
    });
    await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(p.downs).toEqual([...WORKERS]);
    expect(p.ups).toEqual([...WORKERS]);
  });

  /**
   * One seat's `up` failing must not cost the seats after it their turn — a
   * recycle that stopped at the first fault would leave a console MORE broken
   * than the one it was repairing, and the next boundary would find it anyway.
   */
  test("a seat whose `up` throws is logged and the seats after it still get their turn", async () => {
    const saved: TriageActorCursor[] = [];
    const h = harness({ live: [true], maxPasses: 1 });
    const p = recyclePorts({
      runs: [fourRuns(), fourRuns()],
      resume: resumed(),
      upSeat: async (seat) => {
        if (seat === "obs-t1") throw new Error("no image for obs-t1");
      },
    });
    await runTriageActor(
      {
        ...h.deps,
        ports: p.ports,
        saveCursor: async (c) => {
          saved.push(c);
        },
      },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(p.downs).toEqual([...WORKERS]);
    const failed = h.spy.events.filter((e) => e.kind === "recycle_failed");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toEqual({
      kind: "recycle_failed",
      worker: "obs-t1",
      reason: "no image for obs-t1",
    });
    expect(h.spy.events.filter((e) => e.kind === "seat_recycled")).toHaveLength(3);
    /*
     * THE STAMP IS NOT WRITTEN, and this is the assertion the event count above
     * cannot make. An `up` that threw minted no run, so a clock advanced anyway
     * would tell the next boundary the seat is fresh when it has no pin at all —
     * and the seat would then be repaired only by the absent clause, one window
     * late and with the record lying about why.
     */
    expect(saved.at(-1)!.recycled_at).toEqual({
      "tri-1": 100,
      "obs-t1": 40,
      "obs-t2": 100,
      "obs-t3": 100,
    });
  });
});

// ---------------------------------------------------------------------------
// §6.6's gate — "no sweep is admitted while any seat's pin is unresolved"
// ---------------------------------------------------------------------------

describe("no sweep is admitted while any seat's pin is unresolved (§6.6 layer 4)", () => {
  /**
   * Constraint B is the reason: *"a pinned worker the relay cannot resolve
   * refuses every fan-out"*, so a sweep dispatched into a half-recycled console
   * fails four times and **reads as a model problem**.
   *
   * The fixture holds the recycle still — `inFlight` — so the ONLY thing being
   * measured is the gate. Otherwise the boundary would repair the pin and the
   * test would be measuring the repair.
   */
  test("a fixture with one pin unresolved admits no sweep", async () => {
    const h = harness({ live: [true, true], maxPasses: 2 });
    const threeOfFour = { "tri-1": "r-tri", "obs-t1": "r-o1", "obs-t3": "r-o3" };
    // The premise: exactly ONE seat is missing, so this is a half-recycled
    // console rather than a console that is simply not there.
    expect(Object.keys(threeOfFour)).toHaveLength(WORKERS.length - 1);
    const p = recyclePorts({ runs: [threeOfFour], inFlight: true, resume: resumed() });
    const exit = await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(exit.kind).toBe("stopped");
    expect(h.counts().passes).toBe(0);
    const withheld = h.spy.events.filter((e) => e.kind === "sweep_withheld");
    expect(withheld).toHaveLength(2);
    expect(withheld[0]).toEqual({ kind: "sweep_withheld", seats: ["obs-t2"] });
  });

  /** THE CONTROL: the same harness with four pins sweeps. */
  test("the same fixture with all four pins resolved sweeps", async () => {
    const h = harness({ live: [true, true], maxPasses: 2 });
    const p = recyclePorts({ runs: [fourRuns()], inFlight: true, resume: resumed() });
    const exit = await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(exit.kind).toBe("stopped");
    expect(h.counts().passes).toBe(2);
    expect(h.spy.events.some((e) => e.kind === "sweep_withheld")).toBe(false);
  });

  /**
   * **A WEDGED CONSOLE MUST STILL BE REAPABLE**, and this is the failure the gate
   * introduces if the watch is put inside it.
   *
   * §12's exit-when-the-console-is-gone criterion is what makes `pifleet down`
   * authoritative over a process it has never heard of. A gate that withheld the
   * WATCH along with the sweep would leave an actor polling a console that no
   * longer exists — forever, silently, with `sweep_withheld` as the only line in
   * §7.7's log and nothing on disk saying the console is gone. So the pins are
   * unresolvable here for the whole run and the actor is still reaped.
   */
  test("a console withholding every sweep is still abandoned when its collator goes", async () => {
    const h = harness({
      live: Array.from({ length: RELAY_ABANDON_PASSES }, () => false),
      maxPasses: RELAY_ABANDON_PASSES + 5,
    });
    const p = recyclePorts({
      runs: [{ "tri-1": "r-tri" }],
      inFlight: true,
      resume: resumed(),
    });
    const exit = await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    // THE PREMISE: not one sweep was admitted, so the reaping cannot be coming
    // from a pass that ran.
    expect(h.counts().passes).toBe(0);
    expect(h.spy.events.filter((e) => e.kind === "sweep_withheld")).toHaveLength(
      RELAY_ABANDON_PASSES,
    );
    expect(exit.kind).toBe("console_gone");
    expect(exit.kind === "console_gone" && exit.passes).toBe(RELAY_ABANDON_PASSES);
  });

  /**
   * §6.6: *"The gate is four pins RE-DERIVED, not four containers running — those
   * are different moments and only the later one is safe."*
   *
   * So the gate reads the pins AFTER the recycle, in the same iteration. A gate
   * that read them before would withhold a sweep from a console it had just
   * repaired, and the fixture that catches that is one whose two `seatRuns()`
   * answers DIFFER.
   */
  test("the gate reads the pins re-derived AFTER the recycle, not the ones before it", async () => {
    const h = harness({ live: [true], maxPasses: 1 });
    const before = { "tri-1": "r-tri", "obs-t1": "r-o1", "obs-t3": "r-o3" };
    const after = { ...before, "obs-t2": "r-new-o2" };
    // The premise: the two answers really are different, or "reads the later
    // one" is unfalsifiable.
    expect(before).not.toEqual(after);
    const p = recyclePorts({ runs: [before, after], resume: resumed() });
    await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(p.ups).toContain("obs-t2");
    // Repaired and swept in ONE cadence, which is only possible if the gate read
    // the second answer.
    expect(h.counts().passes).toBe(1);
    expect(h.spy.events.some((e) => e.kind === "sweep_withheld")).toBe(false);
    expect(p.counts().reads).toBe(2);
  });

  /**
   * A BOUNDARY THE ACTOR CANNOT READ WITHHOLDS, and this is the one place this
   * module's *"a broken instrument is not a negative observation"* rule does NOT
   * apply — because it is answering a different question.
   *
   * The watch's rule protects a HEALTHY actor from being reaped by a broken `ps`.
   * Here the cost is reversed: withholding costs one cadence, and dispatching into
   * a console whose pins might be half-recycled costs four refused fan-outs that
   * §6.6 says *"read as a model problem"*. So an unreadable boundary withholds,
   * tears nothing down, and says so every cadence.
   */
  test("a boundary read that throws withholds the sweep and recycles nothing", async () => {
    const h = harness({ live: [true], maxPasses: 1 });
    const p = recyclePorts({
      runs: [fourRuns()],
      resume: resumed(),
      seatRuns: async () => {
        throw new Error("runs root is not readable");
      },
    });
    const exit = await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(exit.kind).toBe("stopped");
    expect(h.counts().passes).toBe(0);
    expect(p.downs).toEqual([]);
    const unreadable = h.spy.events.filter((e) => e.kind === "boundary_unreadable");
    expect(unreadable).toHaveLength(1);
    expect(unreadable[0]).toEqual({
      kind: "boundary_unreadable",
      reason: "runs root is not readable",
    });
  });

  /**
   * The record is a CURSOR and the run tree is the authority (D12), so a §7.7
   * record that cannot be read degrades the resume into a restart rather than
   * ending the actor — and says so, because a silent degrade here is a whole
   * console torn down for a file-read error.
   */
  test("a record read that throws at start degrades to a restart rather than ending the actor", async () => {
    const h = harness({ live: [true], maxPasses: 1 });
    const p = recyclePorts({ runs: [fourRuns(), fourRuns()], resume: resumed() });
    const ports: TriageConsolePorts = {
      ...p.ports,
      resume: async () => {
        throw new Error("triage-relay.json is not JSON");
      },
    };
    const exit = await runTriageActor(
      { ...h.deps, ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(exit.kind).toBe("stopped");
    expect(h.counts().passes).toBe(1);
    expect(
      h.spy.events.filter(
        (e) => e.kind === "boundary_unreadable" && e.reason.includes("not JSON"),
      ),
    ).toHaveLength(1);
    // With no clock every pinned seat is stamped on first observation, so the
    // degrade costs a WINDOW rather than a console: nothing is torn down.
    expect(p.downs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// §13 task 6.3b — the actor lock, wired
// ---------------------------------------------------------------------------

describe("two `pifleet triage --poll` processes cannot both sweep one run (§6.3b, §9.13)", () => {
  test("a second `--poll` against a held lock refuses BY NAME and dispatches nothing", async () => {
    const h = harness({ live: [true], maxPasses: 1 });
    const p = recyclePorts({
      runs: [fourRuns()],
      resume: resumed(),
      lockPath: "/fixture/pifleet/triage-relay.lock",
      acquireLock: async () => null,
    });
    const exit = await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(exit.kind).toBe("refused");
    // BY NAME: the file an operator would look at, and the console it belongs to.
    const reason = exit.kind === "refused" ? exit.reason : "";
    expect(reason).toContain("/fixture/pifleet/triage-relay.lock");
    expect(reason).toContain("triage");
    // DISPATCHED NOTHING, on every effect this actor has.
    expect(h.counts().passes).toBe(0);
    expect(h.counts().probes).toBe(0);
    expect(p.downs).toEqual([]);
    expect(p.ups).toEqual([]);
    expect(h.sleeps).toEqual([]);
    // It never claimed to have started, either.
    expect(h.spy.events.some((e) => e.kind === "actor_started")).toBe(false);
    expect(h.spy.events.filter((e) => e.kind === "actor_refused")).toHaveLength(1);
  });

  /** THE CONTROL: the same harness with the lock free runs the console. */
  test("the same actor with the lock free sweeps and releases it on the way out", async () => {
    const h = harness({ live: [true], maxPasses: 1 });
    const p = recyclePorts({ runs: [fourRuns(), fourRuns()], resume: resumed() });
    const exit = await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(exit.kind).toBe("stopped");
    expect(h.counts().passes).toBe(1);
    expect(p.counts().releases).toBe(1);
  });

  /**
   * The release is in a `finally`, so the console is not left unstartable by a
   * pass that threw or by a watch that reaped the actor.
   */
  test("the lock is released even when the console is abandoned under a throwing pass", async () => {
    const h = harness({
      live: Array.from({ length: RELAY_ABANDON_PASSES }, () => false),
      maxPasses: RELAY_ABANDON_PASSES + 5,
      pass: async () => {
        throw new Error("the fan-out found no live seat");
      },
    });
    const p = recyclePorts({ runs: [fourRuns()], inFlight: true, resume: resumed() });
    const exit = await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(exit.kind).toBe("console_gone");
    expect(p.counts().releases).toBe(1);
  });

  /**
   * **THE ANTI-TWIN, and §13 says why it outranks the refusal**: *"a lock left by
   * a DEAD pid does not refuse, or the remedy for a crash becomes an operator
   * deleting a file nobody documented."*
   *
   * Driven through the REAL {@link acquireTriageActorLock} over a real file in a
   * hermetic `$HOME`, because the takeover is `console-relay.ts`'s `(pid, start
   * time)` machinery and a stubbed `acquireLock` would assert nothing about it.
   */
  test("a lock left by a DEAD pid does not refuse — the actor takes it over and sweeps", async () => {
    const env = await tempRunsDir();
    assertHermetic(env);
    // A really-dead pid: spawn something, wait for it, then reuse its number.
    const proc = Bun.spawn(["true"]);
    await proc.exited;
    const lockPath = triageActorLockPath(env);
    await mkdir(dirname(lockPath), { recursive: true });
    await writeFile(lockPath, `${proc.pid}\nunverifiable\n`);
    expect(await Bun.file(lockPath).exists()).toBe(true);

    const h = harness({ live: [true], maxPasses: 1 });
    const p = recyclePorts({
      runs: [fourRuns(), fourRuns()],
      resume: resumed(),
      lockPath,
      acquireLock: async () => await acquireTriageActorLock(env),
    });
    const exit = await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(exit.kind).toBe("stopped");
    expect(h.counts().passes).toBe(1);
    // Released on the way out, so the NEXT start is not refused either.
    const again = await acquireTriageActorLock(env);
    expect(again).not.toBeNull();
    await again!.release();
  });

  /**
   * THE ASYMMETRIC HALF. Taking a dead holder's lock must not become taking ANY
   * lock — without this, "always steal it" passes the test above and puts the
   * concurrent-actor bug straight back.
   */
  test("a lock held by a LIVE process still refuses, through the same seam", async () => {
    const env = await tempRunsDir();
    assertHermetic(env);
    const held = await acquireTriageActorLock(env);
    expect(held).not.toBeNull();

    const h = harness({ live: [true], maxPasses: 1 });
    const p = recyclePorts({
      runs: [fourRuns()],
      resume: resumed(),
      lockPath: triageActorLockPath(env),
      acquireLock: async () => await acquireTriageActorLock(env),
    });
    const exit = await runTriageActor(
      { ...h.deps, ports: p.ports },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(exit.kind).toBe("refused");
    expect(h.counts().passes).toBe(0);
    await held!.release();
  });
});

// ---------------------------------------------------------------------------
// The un-ported actor — RETIRED 2026-09-07 by §13 task 6.5b
// ---------------------------------------------------------------------------

/*
 * TWO TESTS STOOD HERE AND THEY ARE GONE ON PURPOSE, which is the tripwire
 * firing rather than coverage being lost.
 *
 * They were `"it announces `actor_unsupervised` and still runs the loop it
 * always ran"` and `"a ported actor never announces it"`, and ISC-932's probe
 * named them by those exact strings. The pair existed for one round, while
 * `TriageActorDeps.ports` was OPTIONAL: an un-ported actor announced
 * `actor_unsupervised` on §7.7's log at every start, and that line firing in
 * production was the only available tell that task 6.5b's call site had not
 * landed. ISC-932 was pinned to the BLOCKER's absence deliberately, so that
 * landing the call site would turn the guard RED instead of leaving it quietly
 * green.
 *
 * Task 6.5b landed it. `ports` is now REQUIRED, so an un-ported actor is not a
 * shape TypeScript can construct and a test of it is a test of nothing — and
 * `bun test` strips types rather than checking them, so leaving these two here
 * would have left ISC-932's probe PASSING against a fixture the compiler
 * rejects. Deleting them is what makes the probe say what the criterion always
 * meant it to say.
 *
 * WHERE THE GUARANTEE LIVES NOW, which is strictly stronger than the log line:
 *
 *   - the compiler, at every construction site of `TriageActorDeps`;
 *   - `test/unit/triage-command.test.ts`'s *"--poll takes §7.7's lock…"* and
 *     *"a held lock refuses…"*, which drive the SHIPPED `productionTriageDeps`
 *     loop and assert the lock and the recycle positively rather than asserting
 *     an announcement about their absence.
 *
 * `actor_unsupervised` itself is deliberately left in `TRIAGE_ACTOR_EVENT_KINDS`
 * and in `actorLogLine`: the `ports === undefined` branches are still reachable
 * from a caller that is not TypeScript, and the closed-union test above is what
 * would notice if somebody removed the arm without removing the branch.
 */

describe("the record schema refuses what the actor could not have written", () => {
  test("a negative or fractional counter is refused", async () => {
    const env = await tempRunsDir();
    const base = triageActorRecord(identity(env), cursor());
    for (const bad of [
      { sweep_cursor: -1 },
      { sweep_cursor: 1.5 },
      { consecutive_skips: -1 },
      { cadence_s: 0 },
    ]) {
      expect(TriageActorRecordSchema.safeParse({ ...base, ...bad }).success).toBe(false);
    }
    expect(TriageActorRecordSchema.safeParse(base).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// §6.10's ceiling — the PRODUCER (§13 task 6.8, ISC-891)
// ---------------------------------------------------------------------------

/**
 * **THE CHAIN, JOINED — and the join is the whole criterion.**
 *
 * ISC-885 already pins the MAPPING: `halted_at` present ⇒ `budget_exhausted` ⇒ the
 * dispatch is never reached. It is correct and, in its own words, *"permanently
 * inert"* — because nothing in this repository ever wrote `budget.json` for a
 * console run, so the gate's `budget !== null && budget.halted_at !== null` was
 * false forever and every test over it passed anyway. ISC-891 was filed OPEN and
 * SEPARATE for exactly that reason: *"a criterion whose probe cannot distinguish
 * the two states asserts nothing."*
 *
 * So these fixtures start from SPEND — worker state files on a real run tree — and
 * end at the SHIPPED gate, which is imported rather than re-implemented. The one
 * thing they may not do is stub `halted_at`: a fixture that wrote the halted file
 * by hand would be ISC-885 wearing a new name.
 *
 * **What they do NOT reach, stated rather than left to be discovered.** The link
 * from `budget_exhausted` to the composed ANNOUNCEMENT is `triagePass`'s and is
 * pinned in `test/unit/triage-pass.test.ts` (*"a refused admission dispatches
 * nothing, consumes the id, and raises budget_exhausted"*), with §6.8a's machine
 * owning the dedup. Re-driving those here would duplicate a large harness to
 * re-assert somebody else's criterion. What was missing was the producer.
 */
describe("§6.10's ceiling has a producer, and the console halts on its own spend", () => {
  /**
   * A run tree with four seats and real spend, on disk.
   *
   * §D4 makes a console FOUR runs, so each seat gets its own run directory and its
   * own `run.json` — a fixture that put all four workers in ONE run would agree
   * with an accounting that read `workerPaths(collatorRun, seat)` and could not
   * tell it from one that resolves each seat's own run.
   */
  async function spendingConsole(opts: {
    readonly env: Record<string, string | undefined>;
    readonly ceiling: number | null;
    readonly tokens: Readonly<Record<string, number | null>>;
  }): Promise<{ seatRuns: Record<string, string>; collator: ReturnType<typeof runPaths> }> {
    const root = runsRoot(opts.env);
    const seatRuns: Record<string, string> = {};
    for (const seat of WORKERS) {
      const runId = `r-${seat}`;
      seatRuns[seat] = runId;
      const run = runPaths(runId, root);
      await mkdir(join(run.workersDir, seat), { recursive: true });
      await writeFile(
        run.runJson,
        JSON.stringify({
          schema: "pifleet.run/v1",
          run_id: runId,
          budget: { tokens_ceiling: opts.ceiling },
        }),
      );
      const tokens = opts.tokens[seat] ?? null;
      /*
       * `null` writes NO state file: the seat is mid-recycle, or its supervisor
       * has not flushed yet. The degraded observation is PRODUCED by the tree
       * rather than stubbed at the port, so the production reader is what
       * degrades.
       */
      if (tokens === null) continue;
      await writeFile(join(run.workersDir, seat, "state.json"), seatState(seat, runId, tokens));
      /*
       * Every seat's state file lives in its OWN run's tree. A reader that took
       * `workerPaths(collatorRun, seat)` — the shape a "console is one run"
       * reading produces — finds nothing for the three observers, which lands as
       * three degraded seats rather than as a wrong total.
       */
    }
    return { seatRuns, collator: runPaths(seatRuns[TRIAGE_COLLATOR]!, root) };
  }

  /**
   * One seat's state file, with its spend SPLIT ACROSS BOTH USAGE AXES.
   *
   * `input_tokens` and `output_tokens` are two fields and A6 spend is their sum,
   * so a fixture that put everything in one of them is green for a reader that
   * silently drops the other — a degenerate shape this branch has recorded
   * catching twice. The split is uneven so the two halves cannot be swapped
   * either.
   */
  function seatState(seat: string, runId: string, tokens: number): string {
    const input = Math.floor(tokens / 4);
    return JSON.stringify({
      schema: "pifleet.state/v1",
      worker: seat,
      run_id: runId,
      pid: 4242,
      pgid: 4242,
      started_at: "2026-09-07T00:00:00.000Z",
      phase: "idle",
      epoch: 1,
      usage: { input_tokens: input, output_tokens: tokens - input, usd: 0, priced: false },
    });
  }

  /** The gate, driven. Returns the outcome AND whether the effect behind it ran. */
  async function throughGate(
    collator: ReturnType<typeof runPaths>,
  ): Promise<{ kind: string; reason?: string; dispatched: number }> {
    let dispatched = 0;
    const gated = refuseOnExhaustedBudget(collator, async () => {
      dispatched += 1;
      return { kind: "accepted" };
    });
    const out = await gated({
      taskId: "T-sweep-1-obs-t1",
      worker: "obs-t1",
      title: "t",
      brief: "b",
    });
    return {
      kind: out.kind,
      ...(out.kind === "accepted" ? {} : { reason: out.reason }),
      dispatched,
    };
  }

  test("spend across the ceiling halts the run, and the SHIPPED gate then refuses", async () => {
    const env = await tempRunsDir();
    assertHermetic(env);
    const { seatRuns, collator } = await spendingConsole({
      env,
      ceiling: 6_000_000,
      // 6,000,001 — one token past, which is `resumeBudget`'s STRICT `>` and the
      // same off-by-one ISC-885's own fixture spells as "6000001 of 6000000".
      tokens: { "tri-1": 1, "obs-t1": 2_000_000, "obs-t2": 2_000_000, "obs-t3": 2_000_000 },
    });

    /*
     * BEFORE: no file, and the gate is the permanently-false one ISC-891
     * describes. This is the PREMISE — without it the assertion below passes
     * against a repository whose gate refuses everything.
     */
    const before = await throughGate(collator);
    expect(before.kind).toBe("accepted");
    expect(before.dispatched).toBe(1);

    const account = await accountConsoleSpend(
      { seatRuns, seats: [...WORKERS] },
      productionConsoleBudgetPorts(env),
    );
    expect(account).not.toBeNull();
    expect(account!.degraded).toEqual([]);
    expect(account!.state.tokens_spent).toBe(6_000_001);
    expect(account!.state.halted_at).not.toBeNull();

    // The file is real, and it is the one the gate reads.
    const published = JSON.parse(await readFile(collator.budgetJson, "utf8")) as {
      run_id: string;
      halted_at: string | null;
    };
    expect(published.run_id).toBe("r-tri-1");
    expect(published.halted_at).not.toBeNull();

    const after = await throughGate(collator);
    expect(after.kind).toBe("budget_exhausted");
    expect(after.reason).toContain("6000001 of 6000000");
    /*
     * The value of a gate is that the thing behind it did not run — an
     * outcome-only assertion passes for an implementation that dispatches and
     * then relabels. ISC-885's reasoning, re-taken from the producer's side.
     */
    expect(after.dispatched).toBe(0);
  });

  /**
   * **THE ANTI-TWIN, and §13 task 6.8 names it as outranking the first:** *"a
   * producer that always halts satisfies the first alone."*
   *
   * Same tree, same four seats, same ceiling — one token UNDER it. Everything else
   * about the fixture is identical, so a producer that halted on the mere presence
   * of spend, or on a comparison with the wrong direction, dies here and nowhere
   * else.
   */
  test("spend UNDER the ceiling publishes an unhalted budget and refuses nothing", async () => {
    const env = await tempRunsDir();
    const { seatRuns, collator } = await spendingConsole({
      env,
      ceiling: 6_000_000,
      tokens: { "tri-1": 0, "obs-t1": 2_000_000, "obs-t2": 2_000_000, "obs-t3": 1_999_999 },
    });

    const account = await accountConsoleSpend(
      { seatRuns, seats: [...WORKERS] },
      productionConsoleBudgetPorts(env),
    );
    expect(account!.state.tokens_spent).toBe(5_999_999);
    expect(account!.state.halted_at).toBeNull();
    /*
     * The file IS written — "under the ceiling" is a published fact, not a
     * silence. A producer that only wrote on the halt would leave `--status` and
     * every future resume with no evidence the console had spent anything.
     */
    expect(existsSync(collator.budgetJson)).toBe(true);

    const out = await throughGate(collator);
    expect(out.kind).toBe("accepted");
    expect(out.dispatched).toBe(1);
  });

  /**
   * A run nobody budgeted never halts, however much it spends.
   *
   * `tokens_ceiling: null` is `readRunBudgetPolicy`'s honest answer for a
   * `run.json` with no budget block, and it is the third arm the pair above cannot
   * reach: both of those hold a ceiling, so a producer that ignored the ceiling
   * and halted on a hard-coded number would pass one of them.
   */
  test("an unbudgeted run is unbounded, not halted at zero", async () => {
    const env = await tempRunsDir();
    const { seatRuns, collator } = await spendingConsole({
      env,
      ceiling: null,
      tokens: { "tri-1": 1, "obs-t1": 9_000_000, "obs-t2": 0, "obs-t3": 0 },
    });
    const account = await accountConsoleSpend(
      { seatRuns, seats: [...WORKERS] },
      productionConsoleBudgetPorts(env),
    );
    expect(account!.state.tokens_ceiling).toBeNull();
    expect(account!.state.tokens_spent).toBe(9_000_001);
    expect(account!.state.halted_at).toBeNull();
    expect((await throughGate(collator)).kind).toBe("accepted");
  });

  /**
   * **A DEGRADED SEAT FLOORS THE TOTAL, and this console MANUFACTURES the
   * degradation.**
   *
   * `safety/budget.ts` records the hazard for a crashed run — *"a run at 95% of
   * its ceiling that crashes and cannot re-read its transcripts resumes at 0 with
   * a fresh full ceiling — n restarts, n × `tokens_ceiling`"*. Here it needs no
   * crash: §6.6 layer 4 tears a seat down and brings it back up every
   * `recycle_after_sweeps`, and a seat mid-recycle has no state file. Without the
   * floor a halted console un-halts itself four hours into its life, forever.
   */
  test("a seat with no readable state floors the total rather than lowering it", async () => {
    const env = await tempRunsDir();
    const { seatRuns, collator } = await spendingConsole({
      env,
      ceiling: 6_000_000,
      tokens: { "tri-1": 1, "obs-t1": 2_000_000, "obs-t2": 2_000_000, "obs-t3": 2_000_000 },
    });
    const ports = productionConsoleBudgetPorts(env);
    const first = await accountConsoleSpend({ seatRuns, seats: [...WORKERS] }, ports);
    expect(first!.state.tokens_spent).toBe(6_000_001);

    // obs-t3 goes mid-recycle: its state file is gone.
    await rm(join(runPaths("r-obs-t3", runsRoot(env)).workersDir, "obs-t3", "state.json"), {
      force: true,
    });
    const second = await accountConsoleSpend({ seatRuns, seats: [...WORKERS] }, ports);
    expect(second!.degraded).toEqual(["obs-t3"]);
    // NOT 4,000,001 — the observation failed, so the total falls back on the last
    // thing the run published about itself.
    expect(second!.state.tokens_spent).toBe(6_000_001);
    expect((await throughGate(collator)).kind).toBe("budget_exhausted");
  });

  /**
   * And the discriminating half of that rule: a CLEAN observation may legitimately
   * fall, because re-observing is the point.
   *
   * Without this, "floor at the persisted snapshot" is indistinguishable from
   * "never publish a lower number", which is a monotonic accumulator — the thing
   * `resumeBudget`'s docblock refuses by name (*"carrying it forward AND booking
   * deltas against a fresh observation would double-count every resumed worker"*).
   */
  test("a clean observation that fell is published as it is", async () => {
    const env = await tempRunsDir();
    const { seatRuns, collator } = await spendingConsole({
      env,
      ceiling: 6_000_000,
      tokens: { "tri-1": 0, "obs-t1": 500_000, "obs-t2": 0, "obs-t3": 0 },
    });
    const ports = productionConsoleBudgetPorts(env);
    const first = await accountConsoleSpend({ seatRuns, seats: [...WORKERS] }, ports);
    expect(first!.state.tokens_spent).toBe(500_000);

    // The seat rotated its session and now reports less. Nothing degraded.
    await writeFile(
      join(runPaths("r-obs-t1", runsRoot(env)).workersDir, "obs-t1", "state.json"),
      seatState("obs-t1", "r-obs-t1", 10),
    );
    const second = await accountConsoleSpend({ seatRuns, seats: [...WORKERS] }, ports);
    expect(second!.degraded).toEqual([]);
    expect(second!.state.tokens_spent).toBe(10);
    expect((await throughGate(collator)).kind).toBe("accepted");
  });

  /**
   * **THE HALT IS CARRIED, which is `resumeBudget` rule 2 and is why the halt
   * decision was not written here.** A console that crossed its ceiling and then
   * observed less — a rotation, a recycle, a truncated transcript — stays halted.
   */
  test("a run that already halted stays halted when its observed spend falls", async () => {
    const env = await tempRunsDir();
    const { seatRuns, collator } = await spendingConsole({
      env,
      ceiling: 6_000_000,
      tokens: { "tri-1": 1, "obs-t1": 2_000_000, "obs-t2": 2_000_000, "obs-t3": 2_000_000 },
    });
    const ports = productionConsoleBudgetPorts(env);
    const halted = await accountConsoleSpend({ seatRuns, seats: [...WORKERS] }, ports);
    expect(halted!.state.halted_at).not.toBeNull();

    for (const seat of ["obs-t1", "obs-t2", "obs-t3"]) {
      await writeFile(
        join(runPaths(`r-${seat}`, runsRoot(env)).workersDir, seat, "state.json"),
        seatState(seat, `r-${seat}`, 1),
      );
    }
    const after = await accountConsoleSpend({ seatRuns, seats: [...WORKERS] }, ports);
    expect(after!.degraded).toEqual([]);
    expect(after!.state.tokens_spent).toBe(4);
    expect(after!.state.halted_at).toBe(halted!.state.halted_at);
    expect((await throughGate(collator)).kind).toBe("budget_exhausted");
  });

  /**
   * No collator run is `null` and not a throw — there is no file to publish into
   * and no gate that could read one. The console is mid-repair, which §6.6's
   * *"absent ⇒ due"* clause already handles.
   */
  test("a console with no collator run publishes nothing", async () => {
    const published: string[] = [];
    const ports: ConsoleBudgetPorts = {
      ceiling: async () => 10,
      persisted: async () => null,
      seatTokens: async () => 1,
      publish: async (runId) => void published.push(runId),
    };
    const out = await accountConsoleSpend(
      { seatRuns: { "obs-t1": "r-o1" }, seats: [...WORKERS] },
      ports,
    );
    expect(out).toBeNull();
    expect(published).toEqual([]);
  });
});

/**
 * The loop's half of §13 task 6.8 — WHEN the accounting runs, and what the actor
 * says when it has none.
 *
 * These drive `runTriageActor` with fake ports and never touch the filesystem, so
 * the ORDER and the LOG are what they assert; the block above owns the arithmetic
 * and the join to the gate.
 */
describe("the actor accounts the console's spend, and says so when it cannot", () => {
  /** A budget port that records every call in a shared ordering log. */
  function budgetSpy(opts: {
    readonly order: string[];
    readonly halted?: boolean;
    readonly throws?: boolean;
  }): ConsoleBudgetPorts {
    return {
      ceiling: async () => 6_000_000,
      persisted: async () => null,
      seatTokens: async () => {
        if (opts.throws === true) throw new Error("run.json will not parse");
        return opts.halted === true ? 2_000_000 : 1;
      },
      publish: async (runId) => void opts.order.push(`publish:${runId}`),
    };
  }

  /** Four seats, all pinned, and no recycle — so only the accounting moves. */
  function pinnedPorts(budget?: ConsoleBudgetPorts): TriageConsolePorts {
    const base = recyclePorts({
      seats: [...WORKERS],
      runs: [fourRuns()],
      recycleAfterSweeps: 0,
    }).ports;
    return budget === undefined ? base : { ...base, budget };
  }

  /**
   * **THE ORDER IS THE PROPERTY.** `refuseOnExhaustedBudget` reads `budget.json`
   * INSIDE the pass's own dispatch, so an actor that accounted afterwards would
   * publish a crossing the pass that caused it never sees — the console spends a
   * whole cadence past its ceiling before refusing, every single time. A fixture
   * that only asserted "the accounting happened" is green either way.
   */
  test("the accounting is published BEFORE the pass that will read it", async () => {
    const order: string[] = [];
    const h = harness({
      live: [true, true],
      maxPasses: 2,
      pass: async (n) => {
        order.push(`pass:${n}`);
        return cursor();
      },
    });
    await runTriageActor(
      { ...h.deps, ports: pinnedPorts(budgetSpy({ order })) },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(order).toEqual(["publish:r-tri", "pass:1", "publish:r-tri", "pass:2"]);
  });

  /**
   * **THE WIRING TELL, and it is meant to die.** `TriageConsolePorts.budget` is
   * optional for exactly the reason `TriageActorDeps.ports` was optional for one
   * round — the composition root belonged to another task — so an actor that has
   * no producer announces it on §7.7's log rather than spending in silence.
   *
   * ONCE, not per pass: this is a fact about the build, not about the sweep.
   */
  /*
   * RETIRED 2026-09-07, and the deletion is the criterion closing rather than a
   * test being dropped.
   *
   * Two tests stood here: "an actor with no budget port announces it once and
   * still sweeps" and its mirror. They asserted `actor_unbudgeted`, the loud tell
   * that §6.10's producer was built and not yet wired — `actor_unsupervised`'s
   * pattern, and meant to die the same way.
   *
   * `budget: productionConsoleBudgetPorts(e.env)` landed in the composition root
   * and `TriageConsolePorts.budget` became REQUIRED, so an unbudgeted actor is no
   * longer a shape TypeScript can construct and the event has no reachable
   * emitter. They had to be DELETED rather than left passing: `bun test` strips
   * types, so a `tsc` error does not redden a `-t` probe, and a probe pinned to a
   * blocker's absence that survives the blocker's removal is the guard staying
   * quietly green (ISC-965). The tell for a missing wire is the compiler now.
   */

  /**
   * §6.10's halt is STICKY — `resumeBudget` carries a persisted `halted_at`
   * forward — so a line written per pass is 288 identical records a day in a file
   * that never shrinks. Edge-triggered, and the fixture halts on every pass so a
   * level-triggered implementation writes three.
   */
  test("the halt is logged on the transition, not on every pass after it", async () => {
    const order: string[] = [];
    const h = harness({ live: [true, true, true], maxPasses: 3 });
    await runTriageActor(
      { ...h.deps, ports: pinnedPorts(budgetSpy({ order, halted: true })) },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    const halts = h.spy.events.filter((e) => e.kind === "budget_halted");
    expect(halts).toHaveLength(1);
    expect(halts[0]).toMatchObject({ run_id: "r-tri", spent: 8_000_000, ceiling: 6_000_000 });
    // The accounting itself still ran every pass — the LINE is deduplicated, not
    // the publish, or the gate would read a snapshot that stopped moving.
    expect(order.filter((o) => o.startsWith("publish:"))).toHaveLength(3);
  });

  /**
   * An accounting fault must not become an outage of the thing that diagnoses
   * outages. The gate then reads whatever the last pass published, which is
   * `record_write_failed`'s posture one block down.
   */
  test("a throwing accounting is reported and the sweep still happens", async () => {
    const h = harness({ live: [true], maxPasses: 1 });
    await runTriageActor(
      { ...h.deps, ports: pinnedPorts(budgetSpy({ order: [], throws: true })) },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    const failed = h.spy.events.find((e) => e.kind === "budget_unaccounted");
    expect(failed).toBeDefined();
    expect(failed).toMatchObject({ reason: "run.json will not parse" });
    expect(h.counts().passes).toBe(1);
  });

  /**
   * A WITHHELD sweep accounts nothing, and that is a boundary rather than an
   * omission: nothing was dispatched, so nothing moved, and re-publishing an
   * unchanged snapshot every cadence is a write per five minutes for no reader.
   *
   * The fixture is §6.6's own gate — one seat with no pin — so this also pins the
   * accounting INSIDE the sweep branch rather than above it.
   */
  test("a sweep withheld on an unresolved pin publishes nothing", async () => {
    const order: string[] = [];
    const h = harness({ live: [true], maxPasses: 1 });
    const base = recyclePorts({
      seats: [...WORKERS],
      // obs-t3 has no pin, so §6.6's gate withholds. `recycleAfterSweeps: 0`
      // keeps clause 1 from repairing it inside this single pass.
      runs: [{ "tri-1": "r-tri", "obs-t1": "r-o1", "obs-t2": "r-o2" }],
      recycleAfterSweeps: 0,
      downSeat: async () => {},
      upSeat: async () => {},
    }).ports;
    await runTriageActor(
      { ...h.deps, ports: { ...base, budget: budgetSpy({ order }) } },
      { cadenceS: 300, runId: "r-tri", signal: h.signal },
    );
    expect(h.spy.events.map((e) => e.kind)).toContain("sweep_withheld");
    expect(order).toEqual([]);
    expect(h.counts().passes).toBe(0);
  });
});
