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
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { adoptionRefusal } from "../../src/backends/cmux/operations.ts";
import {
  RelayRecordSchema,
  consoleRelayArgv,
  readRelayStatus,
  relayLogPath,
  relayRecordPath,
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
    expect(relayRecordPath(env)).not.toContain(`${env["PIFLEET_RUNS_DIR"]}/`);
    expect(relayLogPath(env)).not.toContain(`${env["PIFLEET_RUNS_DIR"]}/`);
  });

  test("no record is `absent`, which is the ordinary state and not an error", async () => {
    const env = await tempRunsDir();
    expect((await readRelayStatus(relayRecordPath(env))).kind).toBe("absent");
  });

  test("a record naming THIS process is live", async () => {
    const env = await tempRunsDir();
    const path = relayRecordPath(env);
    const { processStartTime } = await import("../../src/safety/procstart.ts");
    await writeFile(
      path,
      JSON.stringify(
        RelayRecordSchema.parse({
          schema: "pifleet.consolerelay/v1",
          pid: process.pid,
          started: (await processStartTime(process.pid)) ?? "",
          run_id: "r-1",
          pinned: null,
          started_at: new Date().toISOString(),
          log_path: relayLogPath(env),
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
    const path = relayRecordPath(env);
    await writeFile(
      path,
      JSON.stringify(
        RelayRecordSchema.parse({
          schema: "pifleet.consolerelay/v1",
          pid: process.pid,
          started: "not-the-start-time-of-this-process",
          run_id: "r-1",
          pinned: null,
          started_at: new Date().toISOString(),
          log_path: relayLogPath(env),
        }),
      ),
    );
    expect((await readRelayStatus(path)).kind).toBe("stale");
  });

  test("a record that is not a relay record is UNREADABLE, never stale", async () => {
    // Stale means "replace it". Unreadable means "do not signal a pid you could
    // not identify" — `down.ts`'s posture, and the two must not be confused.
    const env = await tempRunsDir();
    const path = relayRecordPath(env);
    await writeFile(path, JSON.stringify({ pid: 1 }));
    const status = await readRelayStatus(path);
    expect(status.kind).toBe("unreadable");
  });

  test("the relay is pointed at a run EXPLICITLY, never left to the default", () => {
    // `resolveCollatorRun` answers "the newest run whose collator DIRECTORY
    // exists", and a directory outlives `pifleet down`. The script has just read
    // the real `alive` flag, so it says which run rather than relying on that.
    expect(consoleRelayArgv("/repo/src/cli/index.ts", "r-7")).toEqual([
      "bun",
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
