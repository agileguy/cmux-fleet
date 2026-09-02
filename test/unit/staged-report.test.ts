/**
 * The voided table becomes route-dependent, and `report` says a task is staged
 * (ISC-451, ISC-452 — SRD-TUI-DISPATCH §7.2, D7).
 *
 * ## The cost this file is here to hold in place
 *
 * §7.2 chose a route-dependent table over a mode-dependent one and named the
 * price in the same breath: *"today one list describes every `tui` worker, and
 * after this there are two shapes of `tui` worker with different guarantees."*
 * Its summary of the whole trade — **"this design converts a mode that voids
 * ten guarantees into a route that voids seven and a half, and adds a second
 * table to keep straight"** — is the sentence these tests are guarding, in both
 * directions: the staged route must say LESS is void, and the typed route must
 * still say exactly what it said before.
 *
 * The second half is the one worth writing tests for. A change that improves
 * what a staged run is told, and silently alters what an ordinary attended run
 * is told, is a regression in the larger population — most `tui` workers are
 * hand-typed at, which is §7.2's own observation about this seat.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { RunReportSchema, type RunReport } from "../../src/contracts.ts";
import { renderRunReport } from "../../src/report/render.ts";
import {
  PANE_MODE_TUI_VOIDED,
  STAGED_ROUTE_TUI_VOIDED,
  voidedFor,
  voidedForDispatchRoute,
} from "../../src/attended/voided.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

const rowFor = (rows: readonly { isc: string; because: string }[], isc: string): string => {
  const hit = rows.find((r) => r.isc === isc);
  expect(hit, `no ${isc} row`).toBeDefined();
  return hit!.because;
};

function report(schedule: RunReport["schedule"] = []): RunReport {
  return RunReportSchema.parse({
    schema: "pifleet.report/v1",
    run_id: "run-r1",
    generated_at: "2026-07-27T00:00:00.000Z",
    schedule,
    merge: [],
  });
}

const scheduleRow = (over: Record<string, unknown>): RunReport["schedule"][number] =>
  ({
    id: "t-1",
    state: "dispatched",
    worker: "tui-1",
    task_id: "t-1",
    depends_on: [],
    blocked_by: null,
    verdict: null,
    ...over,
  }) as RunReport["schedule"][number];

describe("the epoch rows differ by route (ISC-452)", () => {
  const typed = voidedForDispatchRoute("tui", "typed");
  const staged = voidedForDispatchRoute("tui", "staged");

  /**
   * ISC-452's probe, verbatim: "assert both rows' text against the route; one
   * table for both fails." These two are the rows §7.2 says change, and the
   * assertion is inequality rather than a keyword match — a keyword match would
   * pass against a table that merely appended a sentence to both routes.
   */
  test("ISC-84 says something different on each route", () => {
    expect(rowFor(staged, "ISC-84")).not.toBe(rowFor(typed, "ISC-84"));
  });

  test("ISC-85 says something different on each route", () => {
    expect(rowFor(staged, "ISC-85")).not.toBe(rowFor(typed, "ISC-85"));
  });

  /**
   * The DIRECTION, not just the difference. A staged dispatch allocates, so the
   * typed row's flat denial must be gone and the staged row must not have
   * merely reworded it.
   */
  test("the typed route still denies the epoch and the staged route does not", () => {
    expect(rowFor(typed, "ISC-84")).toContain("No epoch is allocated at all");
    expect(rowFor(staged, "ISC-84")).not.toContain("No epoch is allocated at all");
    expect(rowFor(staged, "ISC-84")).toContain("NOT VOID");
  });

  test("the typed route still warns the task runs twice and the staged route qualifies it", () => {
    expect(rowFor(typed, "ISC-85")).toContain("RUNS THE TASK TWICE");
    expect(rowFor(staged, "ISC-85")).toContain("CLOSED");
    // …and it must not overclaim: a person typing the same brief twice is
    // still unprotected, and §7.2 says nothing can close that.
    expect(rowFor(staged, "ISC-85")).toContain("STILL OPEN");
  });

  /**
   * ISC-87 is the row §7.2 says is "unchanged in kind and reachable for the
   * first time" — a claim this design makes WEAKER before it makes it
   * stronger, because the mechanism it describes had never executed.
   */
  test("ISC-87 records that its mechanism had never run", () => {
    expect(rowFor(staged, "ISC-87")).toContain("REACHABLE FOR THE FIRST TIME");
  });

  /**
   * ISC-86's force is unchanged and its PROOF is weaker: a file was written,
   * which is less than bytes reaching a pty.
   */
  test("ISC-86 names the weaker proof the staged route can offer", () => {
    expect(rowFor(staged, "ISC-86")).toContain("FILE WAS WRITTEN");
  });
});

describe("the rows that must NOT move", () => {
  /**
   * §7.2 lists ISC-141 as unchanged. Byte-identical rather than merely
   * "mentions a fence", because a row that drifted by one word is a claim
   * change nobody decided to make. The delta table gets this by construction —
   * ISC-141 is not in it — and this asserts the construction held.
   */
  test("ISC-141 is byte-identical across both routes", () => {
    expect(rowFor(voidedForDispatchRoute("tui", "staged"), "ISC-141")).toBe(
      rowFor(voidedForDispatchRoute("tui", "typed"), "ISC-141"),
    );
  });

  /**
   * THE REGRESSION GUARD, and the most important test in this file. A run with
   * nothing staged must get exactly the table it got before this existed —
   * asserted against the function itself rather than against a copy of its
   * text, so it cannot drift.
   */
  test("the typed route is the mode table, unchanged", () => {
    expect(voidedForDispatchRoute("tui", "typed")).toEqual(voidedFor("tui"));
  });

  /**
   * An rpc worker has no staged route to be on — `dispatch` sends it down the
   * control socket. Asking for one must not attach the tui mode's sentences to
   * a worker that is not in the mode.
   */
  test("an rpc worker is unaffected by the route argument", () => {
    expect(voidedForDispatchRoute("rpc", "staged")).toEqual(voidedFor("rpc"));
  });

  /** The delta touches exactly the four rows §7.2 names, and no others. */
  test("the delta is the four rows and no more", () => {
    expect(STAGED_ROUTE_TUI_VOIDED.map((v) => v.isc).sort()).toEqual([
      "ISC-84",
      "ISC-85",
      "ISC-86",
      "ISC-87",
    ]);
  });

  /**
   * The invariant this module has always had, extended to the new table: an
   * `isc` naming nothing is worse than no row, because it looks authoritative
   * while pointing at a criterion that does not exist.
   */
  test("every id in the staged table is DEFINED in ISA.md", () => {
    const isa = readFileSync(`${ROOT}ISA.md`, "utf8");
    const defined = new Set(
      [...isa.matchAll(/^- \[[ x~]\] (ISC-\d+[a-z]?):/gm)].map((m) => m[1]!),
    );
    expect(defined.size).toBeGreaterThan(100);
    for (const v of STAGED_ROUTE_TUI_VOIDED) expect(defined.has(v.isc)).toBe(true);
  });

  /** The mode table is untouched — the delta is applied over it, never into it. */
  test("the mode table still holds the typed sentences", () => {
    expect(rowFor(PANE_MODE_TUI_VOIDED, "ISC-84")).toContain("No epoch is allocated at all");
  });
});

describe("report names a staged-but-untriggered task (ISC-451)", () => {
  test("a staged row gets its own section, above the totals", () => {
    const out = renderRunReport(report([scheduleRow({ state: "staged" })]));
    expect(out).toContain("## STAGED");
    expect(out).toContain("dispatched and never triggered");
    expect(out).toContain("t-1: staged on worker tui-1");
    // Above the totals, per this module's no-footnote rule.
    expect(out.indexOf("## STAGED")).toBeLessThan(out.indexOf("task(s):"));
  });

  /**
   * The line names the REMEDY. A staged task is the one finding in this report
   * an operator can clear in five seconds, and the one that otherwise waits
   * forever — so "there is a staged task" without "here is how it starts" is
   * the sentence that sends them to read the SRD.
   */
  test("it says how to start it and how to release it", () => {
    const out = renderRunReport(report([scheduleRow({ state: "staged" })]));
    expect(out).toContain("/policy/dispatch");
    expect(out).toContain("pifleet unstage --task");
  });

  /**
   * THE CONTROL. A dispatched task must produce no staged section — otherwise
   * the section is decoration rather than a finding.
   */
  test("an ordinary dispatched task produces no staged section", () => {
    const out = renderRunReport(report([scheduleRow({ state: "dispatched" })]));
    expect(out).not.toContain("## STAGED");
  });

  test("a settled task produces no staged section", () => {
    const out = renderRunReport(report([scheduleRow({ state: "done", verdict: "success" })]));
    expect(out).not.toContain("## STAGED");
  });

  /**
   * The schedule row itself must say `staged` too. The section above it is a
   * mitigation; this is the row that would otherwise read
   * `- t-1: dispatched worker=tui-1` — character-for-character what a running
   * task renders as, which is the misreading ISC-451 exists to prevent.
   */
  test("the schedule row does not call a staged task dispatched", () => {
    const out = renderRunReport(report([scheduleRow({ state: "staged" })]));
    // `parts.join("  ")` — two spaces, which is this renderer's own separator.
    expect(out).toContain("- t-1: staged  worker=tui-1");
    expect(out).not.toContain("- t-1: dispatched");
  });
});
