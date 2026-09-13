/**
 * The fleet row's severity colour answers "is anything happening", and the
 * transcript-write ladder is not allowed to answer it.
 *
 * WHAT WAS BROKEN. The bullet took its colour from `activity`, which measures
 * TRANSCRIPT WRITES. That proxy was measured wrong in both directions on the
 * same worker inside two minutes:
 *
 *     tst-1  wrote 1m ago   phase busy   -> quiet  -> white, indistinguishable
 *                                           from four idle workers, while
 *                                           running a 1120-test suite
 *     tst-1  wrote 19s ago  phase idle   -> active -> green, having finished
 *
 * A long tool call writes nothing while doing the most work of the run, and a
 * worker's last write lands exactly as it stops — so the ladder is loudest
 * when least is happening. `phase` is what `state.json` says about whether an
 * epoch is held, and it is what the colour reports now.
 *
 * This tests the DECISION rather than the rendered frame on purpose. Whether
 * SGR escapes appear at all depends on chalk's level, computed from the real
 * stdout, so a piped test runner can produce a frame with no colour in it —
 * an assertion on escapes would pass vacuously exactly where it is run.
 */
import { describe, expect, test } from "bun:test";
import { containerCell, containerColour, egressContainers, phaseCell, rowColour } from "../../src/monitor/views/fleet.tsx";
import { failed, never, ok, type FleetModel } from "../../src/monitor/model.ts";
import { workerContainerName } from "../../src/run/paths.ts";
import { COLOUR, PLAIN } from "../../src/monitor/views/chrome.tsx";
import type { Activity, WorkerRow } from "../../src/monitor/model.ts";

function row(over: Partial<WorkerRow> = {}): WorkerRow {
  return {
    workerId: "tst-1",
    runId: "run-1",
    activity: "quiet",
    phase: "idle",
    transcriptAgeMs: 60_000,
    containerPresent: true,
    taskId: null,
    via: null,
    fence: null,
    workspace: null,
    workspaceName: null,
    ...over,
  };
}

describe("phase decides the row colour", () => {
  test("busy is live, however long ago it last wrote", () => {
    // The first measured failure: a worker deep in one long tool call.
    for (const activity of ["quiet", "active", "rpc"] as Activity[]) {
      expect(rowColour(row({ phase: "busy", activity }), COLOUR)).toBe(COLOUR.live);
    }
  });

  test("idle is dim, however recently it wrote", () => {
    // The second: the last write lands as the worker stops.
    for (const activity of ["quiet", "active", "rpc"] as Activity[]) {
      expect(rowColour(row({ phase: "idle", activity }), COLOUR)).toBe(COLOUR.dim);
    }
  });

  test("the two are actually different colours — the test's own control", () => {
    // Without this, a palette that mapped live and dim to one value would make
    // both cases above pass while the screen stayed unreadable.
    expect(COLOUR.live).not.toBe(COLOUR.dim);
    expect(rowColour(row({ phase: "busy" }), COLOUR)).not.toBe(
      rowColour(row({ phase: "idle" }), COLOUR),
    );
  });

  test("a vanished container is alarm even while state.json says busy", () => {
    /*
     * The row that must never be green: the supervisor believes the worker is
     * working and `docker ps` cannot find it. Painting that live would hide
     * the single most actionable finding the monitor has.
     */
    expect(rowColour(row({ phase: "busy", activity: "container-gone" }), COLOUR)).toBe(
      COLOUR.alarm,
    );
  });

  test("a worker that never produced a transcript keeps its warning, busy or idle", () => {
    for (const phase of ["busy", "idle"]) {
      expect(rowColour(row({ phase, activity: "no-transcript" }), COLOUR)).toBe(COLOUR.warn);
    }
  });

  test("with colour off every state is undefined — no styling leaks into a piped frame", () => {
    for (const activity of ["quiet", "active", "rpc", "no-transcript", "container-gone"] as Activity[]) {
      for (const phase of ["busy", "idle"]) {
        expect(rowColour(row({ phase, activity }), PLAIN)).toBeUndefined();
      }
    }
  });
});

/**
 * The phase and container cells: a word, not a sentence.
 *
 * Both read as `<heading> <value>` — `phase idle`, `container up` — in columns
 * 18 and 21 wide. The first word was the column's own name repeated on every
 * row, so most of the width said what the position already said, and the state
 * an operator was scanning for was the LAST word rather than the first.
 */
describe("the phase cell", () => {
  test("renders the bare word, capitalised", () => {
    expect(phaseCell("idle")).toBe("Idle");
    expect(phaseCell("busy")).toBe("Busy");
  });

  test("a phase this view has never heard of still renders as itself", () => {
    /*
     * `state.json` owns the vocabulary and it has six words today. A `switch`
     * with a default would have to choose between inventing a label and
     * rendering nothing, and both lose the word the supervisor actually wrote.
     */
    for (const p of ["starting", "settling", "stalled", "dead", "something-new"]) {
      expect(phaseCell(p)).toBe(p[0]!.toUpperCase() + p.slice(1));
    }
  });

  test("an empty phase is a dash, not an empty cell", () => {
    // An empty cell is indistinguishable from a column that failed to render.
    expect(phaseCell("")).toBe("—");
  });
});

describe("the container cell", () => {
  test("Up and Down, in green and red", () => {
    expect(containerCell(true)).toBe("Up");
    expect(containerColour(true, COLOUR)).toBe(COLOUR.live);
    expect(containerCell(false)).toBe("Down");
    expect(containerColour(false, COLOUR)).toBe(COLOUR.alarm);
  });

  test("unknown is a dim dash — NOT Down", () => {
    /*
     * The state that matters. `null` is the slow clock not having completed,
     * so every worker is `null` for the first half-cycle after `up`. Rendering
     * that as a bold red `Down` would put the monitor's most actionable
     * finding on every row at startup and teach the operator to ignore it.
     */
    expect(containerCell(null)).toBe("—");
    expect(containerColour(null, COLOUR)).toBe(COLOUR.dim);
    expect(containerColour(null, COLOUR)).not.toBe(COLOUR.alarm);
  });

  test("the three colours are actually three — the test's own control", () => {
    const seen = new Set([
      containerColour(true, COLOUR),
      containerColour(false, COLOUR),
      containerColour(null, COLOUR),
    ]);
    expect(seen.size).toBe(3);
  });

  test("with colour off all three are undefined", () => {
    for (const v of [true, false, null]) {
      expect(containerColour(v, PLAIN)).toBeUndefined();
    }
  });
});

/**
 * The egresses region lists the egress relays and nothing else.
 *
 * It used to list every container no worker row accounted for, which on a
 * shared Docker host put unrelated stacks beside the relays. The relays are
 * the ones worth a line: every worker's outbound traffic goes through one, and
 * a worker whose relay has died fails at its first request with nothing on
 * this screen to explain why.
 */
describe("egressContainers", () => {
  const RUN = "2026-09-04T04-54-27Z-59e3";
  const model = (containers: FleetModel["containers"]): FleetModel =>
    ({
      runs: ok([{ runId: RUN, workers: [row({ workerId: "tst-1" })] }], 0),
      containers,
      now: 0,
      columns: 120,
      view: { kind: "fleet" },
      history: never(),
      detail: never(),
      report: never(),
    }) as FleetModel;

  test("it keeps the relays and drops everything else in one call — the discriminating case", () => {
    /*
     * Either half alone passes on a broken filter: "returns everything" keeps
     * the relays, "returns nothing" drops the rest. Only a list holding both
     * rules out both. `my-egress-proxy` is here because the match is a PREFIX:
     * a container that merely mentions egress is not one of the fleet's relays.
     */
    const own = workerContainerName(RUN, "tst-1");
    const omlx = "pifleet-egress-relay-pifleet-egress-omlx";
    const gabe = "pifleet-egress-relay-pifleet-egress-gabe";
    const all = [own, omlx, "some-app", gabe, "my-egress-proxy", "some-app-db"];
    expect(egressContainers(model(ok(all, 0)))).toEqual([omlx, gabe]);
  });

  test("the worker name is built by the production function, not a literal", () => {
    // A hand-written `pifleet-<run>-<worker>` here would keep passing after a
    // rename — which is exactly what the old `pifleet-3906-eng-1` fixture did.
    expect(workerContainerName(RUN, "tst-1")).toBe(`pifleet-${RUN}-tst-1`);
  });

  test("a failed docker read lists nothing", () => {
    expect(egressContainers(model(failed("boom", 0)))).toEqual([]);
  });
});
