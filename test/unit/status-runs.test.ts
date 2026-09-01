/**
 * `runsHoldingAny` — which runs belong to the console about to rebuild itself.
 *
 * ## Why this is a safety test and not a parsing test
 *
 * `scripts/operations --recreate` stops EVERY live run, which is right for that
 * console because both of its runs are its own. The development console cannot
 * copy it: the two stand side by side, and a development rebuild that stopped
 * every run would tear down the operations console's containers as a side
 * effect of a command that never mentioned them.
 *
 * So every case below is really one question — does this stop something it was
 * not asked to stop? The over-matching failures are the ones that matter, and
 * they are the ones a happy-path test would miss.
 */

import { describe, expect, it } from "bun:test";

import { runsHoldingAny } from "../../src/run/status-runs.ts";

/** A `status --all --json` document, in the shape `status` actually emits. */
function doc(runs: { id: string; workers: string[] }[]): string {
  return JSON.stringify({
    runs: runs.map((r) => ({
      run_id: r.id,
      workers: r.workers.map((w) => ({
        id: w,
        alive: true,
        phase: "idle",
        // The field that made the first draft of this wrong — see the
        // over-matching test below.
        session_path: `/runs/${r.id}/sessions/2026-09-01T00-00-00-000Z_${w}.jsonl`,
      })),
    })),
  });
}

const DEV = new Set(["eng-1", "eng-2", "tst-1", "rev-1"]);

describe("only this console's runs are named", () => {
  it("returns the run holding a named worker", () => {
    const d = doc([{ id: "r-dev", workers: ["eng-1"] }]);
    expect(runsHoldingAny(d, DEV)).toEqual(["r-dev"]);
  });

  /** THE ONE THAT MATTERS: somebody else's console must survive. */
  it("leaves runs holding only other workers alone", () => {
    const d = doc([
      { id: "r-ops-obs", workers: ["obs-1"] },
      { id: "r-ops-tick", workers: ["tick-1"] },
      { id: "r-dev-eng", workers: ["eng-1"] },
    ]);
    expect(runsHoldingAny(d, DEV)).toEqual(["r-dev-eng"]);
  });

  it("names each run once even when it holds two named workers", () => {
    // A duplicate would issue a second `down --run` against a run that is
    // already gone, which reports a failure to stop something already stopped.
    const d = doc([{ id: "r-both", workers: ["eng-1", "eng-2"] }]);
    expect(runsHoldingAny(d, DEV)).toEqual(["r-both"]);
  });

  it("matches the worker's id FIELD, not the id appearing anywhere in the run", () => {
    // The over-matching failure. Every worker's `session_path` contains its own
    // id, and a run belonging to somebody else can name a path, an image tag or
    // a branch containing one of ours. A scanner over the raw text matched
    // those; this reads the field.
    const d = JSON.stringify({
      runs: [
        {
          run_id: "r-not-mine",
          workers: [
            { id: "obs-1", session_path: "/runs/r-not-mine/sessions/2026_eng-1.jsonl" },
          ],
        },
      ],
    });
    expect(runsHoldingAny(d, DEV)).toEqual([]);
  });

  it("does not match a longer id that merely starts with a named one", () => {
    // `eng-1` must not claim `eng-10`. Set membership is exact, and this pins
    // that it stayed exact.
    const d = doc([{ id: "r-ten", workers: ["eng-10"] }]);
    expect(runsHoldingAny(d, DEV)).toEqual([]);
  });

  it("returns nothing for an empty worker set", () => {
    // `--workers ""` reaching here must stop NOTHING rather than everything.
    expect(runsHoldingAny(doc([{ id: "r", workers: ["eng-1"] }]), new Set())).toEqual([]);
  });
});

describe("an unreadable status stops nothing", () => {
  /**
   * The caller is a best-effort teardown before a rebuild. Failing to read the
   * status leaves containers running, which is untidy; throwing would refuse to
   * open the console, and defaulting to "all runs" would destroy the other one.
   * Of the three, leaking is the only acceptable failure.
   */
  it("returns no runs for text that is not JSON", () => {
    expect(runsHoldingAny("pifleet: no runs found\n", DEV)).toEqual([]);
    expect(runsHoldingAny("", DEV)).toEqual([]);
  });

  it("returns no runs for JSON with no runs array", () => {
    expect(runsHoldingAny(JSON.stringify({ ok: true }), DEV)).toEqual([]);
    expect(runsHoldingAny(JSON.stringify({ runs: "nope" }), DEV)).toEqual([]);
    expect(runsHoldingAny("null", DEV)).toEqual([]);
  });

  it("treats a run with no workers array as holding NONE of them", () => {
    // Defaulting the other way would make one malformed entry stop everything,
    // which is the exact blast radius this function bounds.
    const d = JSON.stringify({ runs: [{ run_id: "r-bare" }, { run_id: "r-null", workers: null }] });
    expect(runsHoldingAny(d, DEV)).toEqual([]);
  });

  it("skips a run whose id is missing or not a string", () => {
    const d = JSON.stringify({
      runs: [
        { workers: [{ id: "eng-1" }] },
        { run_id: 42, workers: [{ id: "eng-1" }] },
        { run_id: "", workers: [{ id: "eng-1" }] },
        { run_id: "r-good", workers: [{ id: "eng-1" }] },
      ],
    });
    expect(runsHoldingAny(d, DEV)).toEqual(["r-good"]);
  });
});
