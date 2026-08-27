/**
 * Reading the honeypot's evidence back (ISC-125), and the sentences the
 * operator ends up with.
 *
 * The container half is proved in `test/integration/honeypot.test.ts` against
 * a real daemon. Everything here is the half that has to hold when the input
 * is HOSTILE or BROKEN — a worker filling its ledger with junk, a collection
 * that never happened, a container that never armed — and none of those are
 * reachable from a Docker probe without deliberately breaking the fleet.
 */

import { describe, expect, test } from "bun:test";
import { RunReportSchema } from "../../src/contracts.ts";
import { escapeWatchIsFinding, summarizeEscapeWatch } from "../../src/security/honeypot.ts";
import { renderRunReport } from "../../src/report/render.ts";
import type { CollectedVerbgateRecord } from "../../src/run/verbgate-collect.ts";

/** One collected row, wrapping worker bytes the way the collector does. */
const row = (line: string): CollectedVerbgateRecord => ({
  kind: "row",
  ts: "2026-08-27T00:00:00.000Z",
  worker: "eng-1",
  line,
});

const armed = (ts = "2026-08-27T00:00:00.000Z") =>
  row(JSON.stringify({ ts, event: "honeypot_armed", target: "/var/run/docker.sock" }));
const attempt = (seq: number, ts: string) =>
  row(JSON.stringify({ ts, event: "escape_attempt", target: "/var/run/docker.sock", seq }));

/** A verbgate decision — by far the most common line in this file. */
const verb = () =>
  row(JSON.stringify({ ts: "2026-08-27T00:00:00.000Z", decision: "refuse", verb: "delete pod x" }));

function reportWith(watch: unknown[]): string {
  const report = RunReportSchema.parse({
    schema: "pifleet.report/v1",
    run_id: "r-1",
    generated_at: "2026-08-27T00:00:00.000Z",
    security: { escape_watch: watch },
  });
  return renderRunReport(report);
}

describe("summarizeEscapeWatch", () => {
  /**
   * The default that matters most. No records at all is what a caller sees
   * when a container never armed, when collection never ran, or when the audit
   * file is unreadable — and all three must produce the SAME answer, because
   * none of them is evidence that nothing happened.
   */
  test("no records at all is `not watched`, never `clean`", () => {
    const w = summarizeEscapeWatch("eng-1", []);
    expect(w.armed).toBe(false);
    expect(w.attempts).toBe(0);
    expect(escapeWatchIsFinding(w)).toBe(true);
  });

  test("an armed listener with nothing to report is watched and clean", () => {
    const w = summarizeEscapeWatch("eng-1", [armed(), verb(), verb()]);
    expect(w.armed).toBe(true);
    expect(w.attempts).toBe(0);
    expect(w.first_attempt_at).toBeNull();
    expect(escapeWatchIsFinding(w)).toBe(false);
  });

  test("attempts are counted and their window is the first and last stamp", () => {
    const w = summarizeEscapeWatch("eng-1", [
      armed("2026-08-27T00:00:00.000Z"),
      attempt(1, "2026-08-27T00:00:01.000Z"),
      verb(),
      attempt(2, "2026-08-27T00:00:09.000Z"),
    ]);
    expect(w.armed).toBe(true);
    expect(w.attempts).toBe(2);
    expect(w.first_attempt_at).toBe("2026-08-27T00:00:01.000Z");
    expect(w.last_attempt_at).toBe("2026-08-27T00:00:09.000Z");
  });

  /**
   * The window follows COLLECTION order, not timestamp order, and that is a
   * security property rather than a convenience. The `ts` inside a row is
   * worker-authored; sorting on it would let a worker append one row dated
   * 1970 and rewrite the reported window of a real incident.
   */
  test("a back-dated row cannot rewrite the window's start", () => {
    const w = summarizeEscapeWatch("eng-1", [
      armed(),
      attempt(1, "2026-08-27T00:00:05.000Z"),
      attempt(2, "1970-01-01T00:00:00.000Z"),
    ]);
    expect(w.first_attempt_at).toBe("2026-08-27T00:00:05.000Z");
    expect(w.last_attempt_at).toBe("1970-01-01T00:00:00.000Z");
  });

  /**
   * A worker owns the bytes in this file and can write anything at all into
   * it. None of it may throw, and none of it may be counted.
   */
  test("junk a worker wrote is ignored rather than counted or thrown on", () => {
    const w = summarizeEscapeWatch("eng-1", [
      armed(),
      row("not json at all {{{"),
      row("[1,2,3]"),
      row('"a bare string"'),
      row("null"),
      row(JSON.stringify({ event: 12345 })),
      row(JSON.stringify({ event: "something_else" })),
      attempt(1, "2026-08-27T00:00:01.000Z"),
    ]);
    expect(w.attempts).toBe(1);
    expect(w.armed).toBe(true);
  });

  /**
   * A truncation mark is the COLLECTOR's own record about the file (ISC-172).
   * Counting it here would double-report one incident through two surfaces and
   * make the escape count depend on how often the daemon ticked.
   */
  test("a collector truncation mark is not honeypot evidence", () => {
    const w = summarizeEscapeWatch("eng-1", [
      armed(),
      {
        kind: "truncation",
        ts: "2026-08-27T00:00:02.000Z",
        worker: "eng-1",
        reasons: ["tail_rewritten"],
        collected_bytes: 120,
        size_after: 0,
      },
    ]);
    expect(w.attempts).toBe(0);
    expect(w.armed).toBe(true);
  });

  test("the flood marker makes the count a floor and says so", () => {
    const w = summarizeEscapeWatch("eng-1", [
      armed(),
      attempt(1, "2026-08-27T00:00:01.000Z"),
      row(JSON.stringify({ ts: "2026-08-27T00:00:02.000Z", event: "escape_attempt_flood", after: 100 })),
    ]);
    expect(w.flooded).toBe(true);
    // The flood row itself is not an attempt; it is a statement about the ones
    // that stopped being written.
    expect(w.attempts).toBe(1);
  });
});

describe("the report's security section", () => {
  test("an attempt is announced in capitals, above the totals", () => {
    const text = reportWith([
      {
        worker: "eng-1",
        armed: true,
        attempts: 3,
        flooded: false,
        first_attempt_at: "2026-08-27T00:00:01.000Z",
        last_attempt_at: "2026-08-27T00:00:09.000Z",
      },
    ]);
    expect(text).toContain("## ESCAPE ATTEMPT");
    expect(text).toContain("3 connect(s)");
    // Above the totals line, for the reason ATTENDED is: every number below it
    // means something weaker.
    expect(text.indexOf("ESCAPE ATTEMPT")).toBeLessThan(text.indexOf("task(s):"));
  });

  test("a flooded count is presented as a floor, never as the number", () => {
    const text = reportWith([
      {
        worker: "eng-1",
        armed: true,
        attempts: 100,
        flooded: true,
        first_attempt_at: "2026-08-27T00:00:01.000Z",
        last_attempt_at: "2026-08-27T00:00:09.000Z",
      },
    ]);
    expect(text).toContain("at least 100 connect(s)");
    expect(text).toContain("the true count is higher");
  });

  /**
   * The state this whole criterion exists for. An unwatched worker gets the
   * same prominence as a caught one, and the reassuring sentence must not
   * appear beside it.
   */
  test("an unwatched worker is a finding, not a silence", () => {
    const text = reportWith([
      { worker: "eng-1", armed: false, attempts: 0, flooded: false, first_attempt_at: null, last_attempt_at: null },
    ]);
    expect(text).toContain("## NOT WATCHED");
    expect(text).toContain("makes NO claim");
    expect(text).not.toContain("escape detector armed in");
  });

  /**
   * The clean claim names the container count rather than saying "no escape
   * attempts". The bare sentence reads identically whether the detector ran or
   * was absent, which is the ambiguity the `armed` field exists to remove —
   * so the renderer must not be allowed to drift back to it.
   */
  test("the clean claim names how many containers were actually watched", () => {
    const text = reportWith([
      { worker: "eng-1", armed: true, attempts: 0, flooded: false, first_attempt_at: null, last_attempt_at: null },
      { worker: "eng-2", armed: true, attempts: 0, flooded: false, first_attempt_at: null, last_attempt_at: null },
    ]);
    expect(text).toContain("escape detector armed in 2 container(s)");
    expect(text).not.toContain("ESCAPE ATTEMPT");
  });

  /**
   * A run with no workers says nothing at all here. A "0 containers watched"
   * line would be a claim about a run that had nothing to watch.
   */
  test("a run with no workers prints no security section", () => {
    const text = reportWith([]);
    expect(text).not.toContain("escape detector");
    expect(text).not.toContain("NOT WATCHED");
  });
});
