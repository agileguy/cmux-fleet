/**
 * THE CONSOLE'S WIRING — SRD-REVIEW-CONSOLE §6.5 (the actor) and §6.10 (the
 * adoption guard).
 *
 * `scripts/review` runs `main()` at import, so nothing in it can be imported by
 * a test. The decisions therefore live in modules and this file is what checks
 * them: the worker→run map the script hands the relay, the record that makes
 * "start it again" idempotent, and the refusal that stops the console adopting
 * somebody else's window.
 *
 * ## The two degenerate shapes this file is built against
 *
 * **A pin that is nearly complete.** `consoleRunResolution` takes the pinned
 * branch WHOLE, so a map naming three of four workers freezes that gap for the
 * life of the process. A fixture with four live workers cannot tell a
 * completeness test from its absence, so every partial shape — a missing worker,
 * a dead one, an ambiguous one — is asserted to produce NO pin rather than a
 * short one.
 *
 * **An adoption guard that always refuses.** A guard that returned a string
 * unconditionally would pass every "it refuses a stranger's workspace" test and
 * would break the console's own re-open, which is the documented way back to it.
 * The first assertion in that block is therefore the ACCEPTING one.
 *
 * Hermetic: `PIFLEET_RUNS_DIR` is pointed at a temp directory so nothing reads
 * or writes the operator's own `~/.pifleet`, and no test loads `fleet.yaml`,
 * which is gitignored and absent on a clean checkout.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adoptionRefusal } from "../../src/backends/cmux/operations.ts";
import {
  ConsoleWatch,
  RELAY_ABANDON_PASSES,
  RelayRecordSchema,
  acquireRelayLock,
  consoleRelayArgv,
  readRelayStatus,
  relayLogPath,
  relayRecordPath,
  servesConsole,
  writeRelayRecord,
} from "../../src/run/console-relay.ts";
import { consoleRunPins, relayRunPinValue } from "../../src/run/status-runs.ts";

const WORKERS = ["col-1", "rev-arch-1", "rev-ctx-1", "rev-lang-1"];

/** A `status --all --json` document, with per-worker liveness. */
function statusDoc(
  runs: Array<{ run_id: string; workers: Array<{ id: string; alive?: boolean }> }>,
): string {
  return JSON.stringify({
    runs: runs.map((r) => ({
      run_id: r.run_id,
      workers: r.workers.map((w) => ({ id: w.id, alive: w.alive ?? true })),
    })),
  });
}

/** The console as it looks when all four panes are up: one run per worker (D4). */
function fourRuns(): string {
  return statusDoc(WORKERS.map((w, i) => ({ run_id: `r-${i + 1}`, workers: [{ id: w }] })));
}

const temps: string[] = [];
afterEach(async () => {
  for (const t of temps.splice(0)) await rm(t, { recursive: true, force: true });
});

async function tempRunsDir(): Promise<Record<string, string | undefined>> {
  const root = await mkdtemp(join(tmpdir(), "pifleet-console-relay-"));
  temps.push(root);
  return { PIFLEET_RUNS_DIR: join(root, "runs") };
}

describe("the worker→run map the script hands the relay (§6.5)", () => {
  test("a console whose four workers are each live in one run pins all four", () => {
    const map = consoleRunPins(fourRuns(), WORKERS);
    expect(map.pins.size).toBe(4);
    expect(map.pins.get("col-1")).toBe("r-1");
    expect(map.pins.get("rev-lang-1")).toBe("r-4");
    expect(map.missing).toEqual([]);
    expect(map.ambiguous.size).toBe(0);
    expect(relayRunPinValue(map, WORKERS)).toBe(
      "col-1=r-1,rev-arch-1=r-2,rev-ctx-1=r-3,rev-lang-1=r-4",
    );
  });

  /**
   * `pifleet down` REMOVES CONTAINERS AND LEAVES DIRECTORIES, so a run the
   * operator stopped still lists every worker it ever materialised. A pin
   * computed from presence rather than liveness would point the relay at a
   * corpse — and a pin REPLACES the scan that would otherwise have found the
   * live one, so nothing downstream would notice.
   *
   * ASYMMETRIC: the dead run is the NEWER one, so a map that ignored `alive` and
   * took the last writer would pick exactly the wrong answer.
   */
  test("a dead worker is not a holder, however recent its run", () => {
    const map = consoleRunPins(
      statusDoc([
        { run_id: "r-live", workers: [{ id: "col-1", alive: true }] },
        { run_id: "r-dead", workers: [{ id: "col-1", alive: false }] },
      ]),
      ["col-1"],
    );
    expect(map.pins.get("col-1")).toBe("r-live");
    expect(map.ambiguous.size).toBe(0);
  });

  test("a worker held live by two runs is ambiguous and is not pinned", () => {
    // `relay.ts` fails closed on this: a review dispatched into another fleet's
    // worker would be collated here as this console's lens.
    const map = consoleRunPins(
      statusDoc([
        { run_id: "r-mine", workers: [{ id: "col-1" }] },
        { run_id: "r-theirs", workers: [{ id: "col-1" }] },
      ]),
      ["col-1"],
    );
    expect(map.pins.size).toBe(0);
    expect(map.ambiguous.get("col-1")).toEqual(["r-mine", "r-theirs"]);
  });

  test("a worker no live run holds is missing, not silently dropped", () => {
    const map = consoleRunPins(statusDoc([{ run_id: "r-1", workers: [{ id: "col-1" }] }]), WORKERS);
    expect(map.pins.size).toBe(1);
    expect(map.missing).toEqual(["rev-arch-1", "rev-ctx-1", "rev-lang-1"]);
  });

  /**
   * THE COMPLETENESS RULE, and its three separating cases. A partial pin is
   * worse than none: the scan is re-taken every tick and converges as the
   * console comes up, while a pin is frozen at spawn.
   */
  test("an incomplete map spells NO pin at all", () => {
    const oneMissing = consoleRunPins(
      statusDoc(WORKERS.slice(0, 3).map((w, i) => ({ run_id: `r-${i}`, workers: [{ id: w }] }))),
      WORKERS,
    );
    expect(relayRunPinValue(oneMissing, WORKERS)).toBeNull();

    const oneDead = consoleRunPins(
      statusDoc(
        WORKERS.map((w, i) => ({
          run_id: `r-${i}`,
          workers: [{ id: w, alive: w !== "rev-ctx-1" }],
        })),
      ),
      WORKERS,
    );
    expect(relayRunPinValue(oneDead, WORKERS)).toBeNull();

    const oneAmbiguous = consoleRunPins(
      statusDoc([
        ...WORKERS.map((w, i) => ({ run_id: `r-${i}`, workers: [{ id: w }] })),
        { run_id: "r-other-console", workers: [{ id: "rev-arch-1" }] },
      ]),
      WORKERS,
    );
    expect(relayRunPinValue(oneAmbiguous, WORKERS)).toBeNull();
  });

  test("a status document that does not parse pins nothing rather than throwing", () => {
    // The caller is starting a console. Failing to read the status means the
    // relay falls back to its own scan, which is weaker and still an answer.
    const map = consoleRunPins("not json at all", WORKERS);
    expect(map.pins.size).toBe(0);
    expect(map.missing).toEqual(WORKERS);
  });

  test("a run holding two of the console's workers pins both to it", () => {
    // D4 makes this console four runs, but nothing about the map depends on
    // that, and a single-run console (a D4 reversal, §9 Q2) must not need a
    // second implementation.
    const map = consoleRunPins(
      statusDoc([{ run_id: "r-one", workers: WORKERS.map((id) => ({ id })) }]),
      WORKERS,
    );
    expect(relayRunPinValue(map, WORKERS)).toBe(
      "col-1=r-one,rev-arch-1=r-one,rev-ctx-1=r-one,rev-lang-1=r-one",
    );
  });
});

describe("the relay record — what makes 'start it again' idempotent (§6.5)", () => {
  test("the record and the log live beside the runs root, never inside it", async () => {
    const env = await tempRunsDir();
    // Inside would put a non-run file in the directory `runIdsAscending`
    // enumerates, which is how a stray filename becomes a run id.
    expect(relayRecordPath("review", env)).not.toContain(`${env["PIFLEET_RUNS_DIR"]}/`);
    expect(relayLogPath("review", env)).not.toContain(`${env["PIFLEET_RUNS_DIR"]}/`);
  });

  test("no record is `absent`, which is the ordinary state and not an error", async () => {
    const env = await tempRunsDir();
    expect((await readRelayStatus(relayRecordPath("review", env))).kind).toBe("absent");
  });

  test("a record naming THIS process is live", async () => {
    const env = await tempRunsDir();
    const path = relayRecordPath("review", env);
    const { processStartTime } = await import("../../src/safety/procstart.ts");
    await writeFile(
      path,
      JSON.stringify(
        RelayRecordSchema.parse({
          schema: "pifleet.consolerelay/v1",
          pid: process.pid,
          console: "review",
          started: (await processStartTime(process.pid)) ?? "",
          run_id: "r-1",
          pinned: null,
          started_at: new Date().toISOString(),
          log_path: relayLogPath("review", env),
        }),
      ),
    );
    const status = await readRelayStatus(path);
    expect(status.kind).toBe("live");
  });

  /**
   * THE (pid, start-time) IDENTITY, which is the whole reason this is a JSON
   * record and not a pidfile.
   *
   * `registry.ts` records the measurement: a two-day-old dead run was reported
   * live because the OS recycled its pid onto a supervisor started later. Here
   * the consequence runs the other way and is worse — `scripts/review` would
   * find a stranger's process "alive", decline to start a relay, and leave the
   * console silently actorless.
   *
   * ASYMMETRIC: the pid is REAL and running (this process), so only the
   * start-time comparison can separate the two cases.
   */
  test("a record with a live pid but the wrong start time is STALE, not live", async () => {
    const env = await tempRunsDir();
    const path = relayRecordPath("review", env);
    await writeFile(
      path,
      JSON.stringify(
        RelayRecordSchema.parse({
          schema: "pifleet.consolerelay/v1",
          pid: process.pid,
          console: "review",
          // PINNED but wrong: `isPinnedIdentity` accepts the format, so only the
          // start-time comparison can separate this from a live relay.
          started: "utc1 Thu Jan  1 00:00:00 2000",
          run_id: "r-1",
          pinned: null,
          started_at: new Date().toISOString(),
          log_path: relayLogPath("review", env),
        }),
      ),
    );
    expect((await readRelayStatus(path)).kind).toBe("stale");
  });

  test("a record that is not a relay record is UNREADABLE, never stale", async () => {
    // Stale means "replace it". Unreadable means "do not signal a pid you could
    // not identify" — `down.ts`'s posture, and the two must not be confused.
    const env = await tempRunsDir();
    const path = relayRecordPath("review", env);
    await writeFile(path, JSON.stringify({ pid: 1 }));
    const status = await readRelayStatus(path);
    expect(status.kind).toBe("unreadable");
  });

  test("the relay is pointed at a run EXPLICITLY, never left to the default", () => {
    // `resolveCollatorRun` answers "the newest run whose collator DIRECTORY
    // exists", and a directory outlives `pifleet down`. The script has just read
    // the real `alive` flag, so it says which run rather than relying on that.
    // argv[0] is `process.execPath` — the RUNNING bun, never the word `bun`.
    // cmux carries launchd's PATH (four entries, no ~/.bun/bin), so a bare
    // `bun` is `command not found` in anything it spawns. See
    // operations-plan.ts's fourth host fact.
    expect(consoleRelayArgv("/repo/src/cli/index.ts", "r-7")).toEqual([
      process.execPath,
      "run",
      "/repo/src/cli/index.ts",
      "relay",
      "--run",
      "r-7",
    ]);
  });
});

describe("§6.10 — the console does not adopt a workspace it did not create", () => {
  const PLANNED = WORKERS;

  test("its OWN console is adopted, in any pane order", () => {
    // THE ACCEPTING CASE FIRST. A guard that refused everything would pass every
    // refusal test below and break the documented way back to the console.
    expect(adoptionRefusal("review", PLANNED, PLANNED)).toBeNull();
    expect(adoptionRefusal("review", [...PLANNED].reverse(), PLANNED)).toBeNull();
  });

  test("a stranger's `review` workspace is refused and names --recreate", () => {
    const refusal = adoptionRefusal("review", ["notes", "scratch"], PLANNED);
    expect(refusal).toContain("--recreate");
    expect(refusal).toContain("notes, scratch");
    // The consequence, not just the fact: an operator has to know what adopting
    // would have done to the window they were working in.
    expect(refusal).toContain("lose whatever is in them");
  });

  test("a console missing a pane is refused rather than half-adopted", () => {
    expect(adoptionRefusal("review", PLANNED.slice(0, 3), PLANNED)).not.toBeNull();
  });

  test("an extra pane is refused too", () => {
    expect(adoptionRefusal("review", [...PLANNED, "col-1"], PLANNED)).not.toBeNull();
  });

  test("a duplicated pane is refused — the multiset, not the set", () => {
    // A set comparison would adopt this: the same four names are present.
    const dup = ["col-1", "col-1", "rev-arch-1", "rev-ctx-1", "rev-lang-1"];
    expect(adoptionRefusal("review", dup, PLANNED)).not.toBeNull();
  });

  /**
   * The separator case. `["ab","c"]` and `["a","bc"]` concatenate to one string,
   * so a `join("")` key would adopt a workspace whose titles merely spell the
   * same letters.
   */
  test("titles that concatenate alike are still different pane sets", () => {
    expect(adoptionRefusal("review", ["ab", "c"], ["a", "bc"])).not.toBeNull();
  });

  test("an untitled pane is not one of ours", () => {
    expect(adoptionRefusal("review", [null, ...PLANNED.slice(1)], PLANNED)).not.toBeNull();
  });

  test("an empty workspace is refused, and says so rather than listing nothing", () => {
    expect(adoptionRefusal("review", [], PLANNED)).toContain("no panes");
  });
});

/**
 * THE SUPERVISION — §6.5's *"dies with the console"*, and the identity that
 * makes "already running" a question worth asking (§9 Q4).
 *
 * The failure these cover is not the one §6.5 wrote down. It worried about an
 * actor dying mid-fan-out, which the journal already answers. The live one is
 * an actor that does NOT die: a relay left polling a console that is gone,
 * which a manager asking only "is a relay running" reports as healthy — §6.4's
 * own failure shape, reached through the mechanism built to close it.
 */
describe("the watch — the actor's lifetime is bounded by its console's", () => {
  const AT = { worker: "col-1", runId: "r-1", console: "review" as const };

  test("a live console is never abandoned, however long it runs", () => {
    const w = new ConsoleWatch(3);
    for (let i = 0; i < 50; i += 1) expect(w.observe(true, AT)).toBeNull();
    expect(w.streak).toBe(0);
  });

  test("it exits only after a RUN of negatives, never on the first", () => {
    const w = new ConsoleWatch(3);
    expect(w.observe(false, AT)).toBeNull();
    expect(w.observe(false, AT)).toBeNull();
    const reason = w.observe(false, AT);
    expect(reason).toContain("3 consecutive passes");
    expect(reason).toContain("r-1");
  });

  /**
   * THE SEPARATING CASE for "a run, not a count". Liveness is read from a state
   * file and a `ps`, both of which fail transiently; a tolerance that summed
   * isolated failures would end the actor on a race it has no stake in.
   */
  test("one positive observation resets the streak completely", () => {
    const w = new ConsoleWatch(3);
    w.observe(false, AT);
    w.observe(false, AT);
    expect(w.observe(true, AT)).toBeNull();
    expect(w.streak).toBe(0);
    expect(w.observe(false, AT)).toBeNull();
    expect(w.observe(false, AT)).toBeNull();
    expect(w.observe(false, AT)).not.toBeNull();
  });

  test("the shipped tolerance is small enough to matter and large enough to be a run", () => {
    // Every pass spent attached to a dead console is a pass in which a live
    // console's request goes unread, and the operator's remedy is blocked by a
    // relay that still looks alive.
    expect(RELAY_ABANDON_PASSES).toBeGreaterThan(1);
    expect(RELAY_ABANDON_PASSES).toBeLessThanOrEqual(10);
    const w = new ConsoleWatch();
    for (let i = 1; i < RELAY_ABANDON_PASSES; i += 1) expect(w.observe(false, AT)).toBeNull();
    expect(w.observe(false, AT)).not.toBeNull();
  });

  /**
   * §13 task 6.3a — the abandonment sentence names the console it was started
   * for, and this asserts BOTH so the fix cannot be half-made.
   *
   * The sentence used to say `scripts/review` and `SRD-REVIEW-CONSOLE`
   * unconditionally, so a triage actor that reaped itself sent the operator to
   * the wrong script and the wrong document. Task 6.3 found it and could not fix
   * it — the file was not in its slice.
   *
   * **A fixture that only checked triage would pass an implementation that broke
   * review**, which is the whole reason both are asserted here, together with
   * the cross-assertions: each console's reason must NOT carry the other's
   * script. A single-console check passes a table whose two rows are identical.
   */
  test("the reason names the console it was started for, for BOTH consoles", () => {
    const reasonFor = (console_: "review" | "triage") => {
      const w = new ConsoleWatch(1);
      const reason = w.observe(false, { worker: "col-1", runId: "r-1", console: console_ });
      expect(reason, `${console_} produced no reason at tolerance 1`).not.toBeNull();
      return reason!;
    };

    const review = reasonFor("review");
    expect(review).toContain("scripts/review");
    expect(review).toContain("SRD-REVIEW-CONSOLE");
    expect(review).not.toContain("scripts/triage");
    expect(review).not.toContain("SRD-TRIAGE-CONSOLE");

    const triage = reasonFor("triage");
    expect(triage).toContain("scripts/triage");
    expect(triage).toContain("SRD-TRIAGE-CONSOLE");
    expect(triage).not.toContain("scripts/review");
    expect(triage).not.toContain("SRD-REVIEW-CONSOLE");

    // The premise that makes the four negatives above meaningful: the two
    // reasons are genuinely different strings, so a table with two identical
    // rows cannot satisfy this test by accident.
    expect(review).not.toBe(triage);
  });
});

describe("identity — whether a running relay is THIS console's", () => {
  const REC = {
    schema: "pifleet.consolerelay/v1" as const,
    pid: 1,
    started: "utc1 x",
    console: "review",
    run_id: "r-1",
    pinned: null,
    workers: [...WORKERS],
    started_at: "2026-09-04T00:00:00.000Z",
    log_path: "/tmp/x.log",
  };

  test("the same run and the same workers is this console", () => {
    expect(servesConsole(REC, { name: "review", runId: "r-1", workers: WORKERS })).toBe(true);
    // Order is the pane plan's business, not the record's.
    expect(
      servesConsole(REC, { name: "review", runId: "r-1", workers: [...WORKERS].reverse() }),
    ).toBe(true);
  });

  /**
   * THE MEASURED FAILURE. Run the script, close the `review` workspace by hand,
   * run it again: four new runs, and a relay polling the first console's inbox.
   * Without this comparison the manager answers "already running" and the new
   * console has no actor at all.
   */
  test("a different run is NOT this console, however healthy the process", () => {
    expect(servesConsole(REC, { name: "review", runId: "r-5", workers: WORKERS })).toBe(false);
  });

  /**
   * ISC-1057 made the workers arm CONTAINMENT rather than equality, so the
   * discriminating fixture names a seat the relay does not serve. A SUBSET was
   * the old fixture and is now an adopt — correctly: a relay covering four
   * reviewers does serve two of them.
   *
   * On this console the distinction is theoretical, and that is worth saying
   * rather than leaving implied: `startRelay` passes the same list the panes
   * were built from, so `record.workers` equals the caller's set and equality
   * and containment agree. The rule was changed for `triage`, where the record
   * is written from a constant the caller's flag can never match.
   */
  test("a worker the relay does not serve is not this console either", () => {
    expect(
      servesConsole(REC, { name: "review", runId: "r-1", workers: ["col-1", "rev-ghost-1"] }),
    ).toBe(false);
  });

  test("the review console's own set still adopts, exactly as before", () => {
    expect(servesConsole(REC, { name: "review", runId: "r-1", workers: WORKERS })).toBe(true);
    expect(
      servesConsole(REC, { name: "review", runId: "r-1", workers: ["col-1", "rev-arch-1"] }),
    ).toBe(true);
  });
});

describe("the record is durable, comparable, and singly held", () => {
  test("a torn write cannot be observed — the record is written atomically", async () => {
    const env = await tempRunsDir();
    const path = relayRecordPath("review", env);
    await writeRelayRecord(path, {
      schema: "pifleet.consolerelay/v1",
      pid: process.pid,
      console: "review",
      started: "utc1 whatever",
      run_id: "r-1",
      pinned: null,
      workers: [...WORKERS],
      started_at: new Date().toISOString(),
      log_path: relayLogPath("review", env),
    });
    // Round-trips through the schema, which a half-written file cannot.
    const status = await readRelayStatus(path);
    expect(status.kind).toBe("stale");
  });

  /**
   * L2: the capture-failed sentinel. `""` matches no real start time, so
   * comparing it reported a LIVE relay as stale — after which `--recreate`
   * deletes its record and tears down the runs it is polling, leaving exactly
   * the unnameable background process the record exists to prevent.
   *
   * ASYMMETRIC: the pid is this process and is genuinely alive, so only the
   * `isPinnedIdentity` discrimination can produce the right answer.
   */
  test("an unpinned start time is UNVERIFIABLE, never stale", async () => {
    const env = await tempRunsDir();
    const path = relayRecordPath("review", env);
    await writeRelayRecord(path, {
      schema: "pifleet.consolerelay/v1",
      pid: process.pid,
      console: "review",
      started: "",
      run_id: "r-1",
      pinned: null,
      workers: [...WORKERS],
      started_at: new Date().toISOString(),
      log_path: relayLogPath("review", env),
    });
    const status = await readRelayStatus(path);
    expect(status.kind).toBe("unverifiable");
    if (status.kind === "unverifiable") expect(status.reason).toContain("capture failed");
  });

  test("a legacy unpinned format is unverifiable too, not adopted", async () => {
    const env = await tempRunsDir();
    const path = relayRecordPath("review", env);
    await writeRelayRecord(path, {
      schema: "pifleet.consolerelay/v1",
      pid: process.pid,
      console: "review",
      started: "Thu 20 Aug 2026 10:00:00",
      run_id: "r-1",
      pinned: null,
      workers: [...WORKERS],
      started_at: new Date().toISOString(),
      log_path: relayLogPath("review", env),
    });
    expect((await readRelayStatus(path)).kind).toBe("unverifiable");
  });

  /**
   * THE CRASHED HOLDER, which is the case the lock was blind to.
   *
   * `acquireRelayLock` answered `EEXIST` with `null` and never opened the file,
   * so the pid it writes was read by nobody. One hard crash left the lock on
   * disk and no relay could ever start again until a person deleted it — the
   * permanently-actorless console the module exists to prevent.
   */
  /**
   * TWO DIFFERENT CONSOLES THAT MUST NOT COMPARE EQUAL, and a probe filed
   * against a defect that turned out not to exist.
   *
   * A reviewer read `servesConsole` as joining on `""` and filed it as a
   * collision: `["ab", "c"]` and `["a", "bc"]` both render `"abc"`, and every
   * character is legal in a worker id. The reading was reasonable and the
   * conclusion was wrong — the separator was there all along as a literal 0x01
   * byte, invisible in an editor, a diff and a terminal. It is now written as
   * `\u0001`, and this test stays because the property is worth pinning
   * whatever the spelling: replacing the separator with `""` makes it red.
   */
  test("worker sets that concatenate alike are not the same console", () => {
    const rec = {
      schema: "pifleet.relayrecord/v1" as const,
      pid: 1,
      started: "x",
      console: "review",
      run_id: "R",
      workers: ["ab", "c"],
    } as unknown as Parameters<typeof servesConsole>[0];
    expect(servesConsole(rec, { name: "review", runId: "R", workers: ["ab", "c"] })).toBe(true);
    expect(servesConsole(rec, { name: "review", runId: "R", workers: ["a", "bc"] })).toBe(false);
  });

  test("a lock left by a dead process is taken over", async () => {
    const env = await tempRunsDir();
    const lockPath = join(env["PIFLEET_RUNS_DIR"]!, "..", "lock-dead");
    // A really-dead pid: spawn something, wait for it, then reuse its number.
    const proc = Bun.spawn(["true"]);
    await proc.exited;
    await writeFile(lockPath, `${proc.pid}\nunverifiable\n`);

    const taken = await acquireRelayLock(lockPath);
    expect(taken).not.toBeNull();
    await taken!.release();
  });

  /**
   * THE ASYMMETRIC HALF. Taking over a dead holder's lock must not become
   * taking over ANY lock — without this, "always steal it" passes the test
   * above and reintroduces the concurrent-starter bug the lock exists for.
   */
  test("a lock held by a LIVE process is still refused", async () => {
    const env = await tempRunsDir();
    const lockPath = join(env["PIFLEET_RUNS_DIR"]!, "..", "lock-live");
    const held = await acquireRelayLock(lockPath);
    expect(held).not.toBeNull();
    // This process is alive and its identity matches what was written.
    expect(await acquireRelayLock(lockPath)).toBeNull();
    await held!.release();
  });

  /**
   * UNREADABLE IS NOT STALE — `readRelayRecord`'s posture, and `down.ts`'s
   * before it. A lock we cannot parse names a holder we cannot rule out.
   */
  /**
   * THE ZERO-BYTE LOCK, which the FIRST version of the takeover reintroduced.
   *
   * `open(path, "wx")` then `writeFile` leaves a window where the lock exists
   * and is empty, and a crash there is the only reason the takeover exists at
   * all. An empty lock parses to no holder, the takeover refused it forever,
   * and the console was permanently actorless again. Publishing by `link` from
   * a fully-written temp file closes the window: the name never appears before
   * the content. Found by this repository's own review console.
   */
  test("a ZERO-BYTE lock is taken over, because it names no holder", async () => {
    const env = await tempRunsDir();
    const lockPath = join(env["PIFLEET_RUNS_DIR"]!, "..", "lock-empty");
    // The residue of a claim that died between creating the name and writing
    // into it. Older builds of acquireRelayLock could produce exactly this.
    await writeFile(lockPath, "");

    const taken = await acquireRelayLock(lockPath);
    expect(taken).not.toBeNull();
    // And what it published is complete, not another empty file.
    expect(Number.parseInt((await readFile(lockPath, "utf8")).split("\n")[0]!, 10)).toBe(
      process.pid,
    );
    await taken!.release();
  });

  test("a lock whose contents make no sense is refused, not stolen", async () => {
    const env = await tempRunsDir();
    const lockPath = join(env["PIFLEET_RUNS_DIR"]!, "..", "lock-junk");
    await writeFile(lockPath, "not-a-pid\n");
    expect(await acquireRelayLock(lockPath)).toBeNull();
  });

  test("only one starter at a time, and the loser is told", async () => {
    const env = await tempRunsDir();
    const lockPath = join(env["PIFLEET_RUNS_DIR"]!, "..", "lock");
    const first = await acquireRelayLock(lockPath);
    expect(first).not.toBeNull();
    expect(await acquireRelayLock(lockPath)).toBeNull();
    await first!.release();
    // Released, so the next invocation may proceed.
    const third = await acquireRelayLock(lockPath);
    expect(third).not.toBeNull();
    await third!.release();
  });
});
