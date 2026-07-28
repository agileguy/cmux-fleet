/**
 * Human rendering of a RunReport (SRD §10).
 *
 * The load-bearing assertions are about WORDING, deliberately: this project
 * already shipped a `down` that printed `"clean": true` over a leaked tmux
 * session, and the render layer is where a correct boolean turns into a
 * false sentence. A clean pre-check must read as a prediction ("as of this
 * check", "NOT merged"), never as an event.
 */

import { describe, expect, test } from "bun:test";
import { MergePrecheckSchema, RunReportSchema, type RunReport } from "../../src/contracts.ts";
import { renderRunReport } from "../../src/report/render.ts";

const SHA = "d".repeat(40);

function report(overrides: Partial<RunReport> = {}): RunReport {
  return RunReportSchema.parse({
    schema: "pifleet.report/v1",
    run_id: "run-r1",
    generated_at: "2026-07-27T00:00:00.000Z",
    schedule: [],
    merge: [],
    ...overrides,
  });
}

function precheck(overrides: Record<string, unknown>): RunReport["merge"][number] {
  return MergePrecheckSchema.parse({
    worker: "w1",
    branch: "fleet/r/w1",
    base_ref: SHA,
    clean: false,
    ...overrides,
  });
}

describe("renderRunReport — merge wording", () => {
  /**
   * Would fail if "clean" ever renders without its qualifiers. Both halves
   * are asserted: the check-time scoping AND the explicit negative, because
   * either alone still lets a skimming reader believe something landed.
   */
  test("a clean pre-check says as-of-this-check and NOT merged", () => {
    const out = renderRunReport(report({ merge: [precheck({ clean: true })] }));
    expect(out).toContain("as of this check");
    expect(out).toContain("NOT merged");
    expect(out).not.toContain("merged cleanly\n"); // never the bare event claim
  });

  // Would fail if conflicts_with stopped leading the conflict rendering:
  // worker ids are the operator's next conversation, paths come second.
  test("a conflicted pre-check names the sibling workers and the paths", () => {
    const out = renderRunReport(
      report({
        merge: [
          precheck({
            conflicts_with: ["w2"],
            conflicting_paths: ["shared.txt"],
            detail: "conflicts with sibling w2 in 1 path(s)",
          }),
        ],
      }),
    );
    expect(out).toContain("CONFLICTS");
    expect(out).toContain("talk to: w2");
    expect(out).toContain("conflict: shared.txt");
  });

  // Would fail if "not clean, no conflicts" — the deleted-branch shape —
  // rendered as either clean or conflicted instead of unchecked.
  test("an uncheckable branch renders as could-not-be-checked", () => {
    const out = renderRunReport(
      report({ merge: [precheck({ detail: "branch fleet/r/w1 does not resolve; nothing was checked" })] }),
    );
    expect(out).toContain("could not be checked");
    expect(out).not.toContain("NOT merged");
    expect(out).not.toContain("CONFLICTS");
  });
});

describe("renderRunReport — schedule and notes", () => {
  test("rows carry state, worker, verdict, and the blocking cause", () => {
    const out = renderRunReport(
      report({
        schedule: [
          { id: "a", state: "done", worker: "w1", task_id: "T-1", depends_on: [], blocked_by: null, verdict: "success" },
          { id: "b", state: "blocked", worker: null, task_id: null, depends_on: ["a"], blocked_by: "a", verdict: null },
          { id: "c", state: "waiting", worker: null, task_id: null, depends_on: ["b"], blocked_by: null, verdict: null },
        ],
      }),
    );
    expect(out).toContain("- a: done  worker=w1  verdict=success");
    // The cause, not just the cascade — would fail if blocked_by vanished.
    expect(out).toContain("- b: blocked  blocked by a");
    expect(out).toContain("- c: waiting  waiting on b");
  });

  test("an empty run says so instead of rendering nothing", () => {
    const out = renderRunReport(report());
    expect(out).toContain("no tasks were dispatched");
    expect(out).toContain("no worker branches to check");
  });

  test("totals appear on one line", () => {
    const out = renderRunReport(
      report({ totals: { tasks: 3, done: 1, blocked: 1, failed: 1 } }),
    );
    expect(out).toContain("3 task(s): 1 done, 1 blocked, 1 failed");
  });

  // Would fail if collection notes were dropped on the human path — the JSON
  // path carries them separately, and losing them here hides degradation
  // exactly from the reader who cannot parse JSON to find it.
  test("collection notes render when present and not otherwise", () => {
    const withNotes = renderRunReport(report(), ["ledger: shard torn"]);
    expect(withNotes).toContain("## collection notes");
    expect(withNotes).toContain("- ledger: shard torn");
    expect(renderRunReport(report())).not.toContain("## collection notes");
  });
});
