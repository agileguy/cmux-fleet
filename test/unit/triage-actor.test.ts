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
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
  acquireTriageActorLock,
  actorLogLine,
  appendActorLog,
  parseTriageActorRecord,
  readTriageActorRecord,
  runTriageActor,
  triageActorLockPath,
  triageActorLogPath,
  triageActorRecord,
  triageActorRecordPath,
  writeTriageActorRecord,
} from "../../src/run/triage-actor.ts";
import type {
  TriageActorCursor,
  TriageActorDeps,
  TriageActorEvent,
} from "../../src/run/triage-actor.ts";

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
      { kind: "pass_failed", reason: "boom\nkind=console_gone worker=tri-1\r\n evil" },
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
      "actor_started",
      "actor_stopped",
      "console_gone",
      "console_unobservable",
      "pass_completed",
      "pass_failed",
      "record_write_failed",
    ]);
    const sample: TriageActorEvent[] = [
      { kind: "actor_started", pid: 1, run_id: "r-tri", cadence_s: 300 },
      { kind: "pass_completed", sweep_cursor: 4, consecutive_skips: 1 },
      { kind: "pass_failed", reason: "boom" },
      { kind: "record_write_failed", reason: "ENOSPC" },
      { kind: "console_unobservable", worker: "tri-1", reason: "ps under load" },
      { kind: "console_gone", worker: "tri-1", run_id: "r-tri", passes: 5 },
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
    expect(saved).toEqual([{ runs: fourRuns(), sweep_cursor: 99, consecutive_skips: 2 }]);
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
