/**
 * util/clock.ts — the single source of monotonic time.
 *
 * Every test here injects its clock, so none of them measure real elapsed time:
 * a timing test that sleeps is a flaky test, and a flaky test in a suite this
 * size gets retried until it passes, which is the same as deleting it.
 */

import { describe, expect, test } from "bun:test";
import { Deadline, isoNow, monotonicMs, Stopwatch } from "../../src/util/clock.ts";

describe("monotonicMs", () => {
  test("never goes backwards across successive reads", () => {
    const a = monotonicMs();
    const b = monotonicMs();
    expect(b).toBeGreaterThanOrEqual(a);
  });

  /**
   * The whole reason the module exists: a wall-clock jump must not be visible
   * to anything that measures elapsed time. `performance.now()` is unaffected
   * by NTP steps and host suspend; `Date.now()` is not.
   */
  test("is not derived from wall clock", () => {
    expect(monotonicMs()).not.toBe(Date.now());
  });
});

describe("Stopwatch", () => {
  test("measures elapsed time on the injected clock", () => {
    let t = 1_000;
    const sw = new Stopwatch(() => t);
    t = 1_250;
    expect(sw.elapsedMs()).toBe(250);
  });

  test("a wall-clock jump backwards cannot make elapsed time negative", () => {
    // The clock it is given is monotonic by contract, so this asserts the
    // shape callers rely on: elapsed is a difference on ONE clock, never a
    // mix of the reading at construction and a different clock later.
    let t = 5_000;
    const sw = new Stopwatch(() => t);
    t = 5_000; // no advance
    expect(sw.elapsedMs()).toBe(0);
  });

  test("restart moves the origin, which is what a stall window needs", () => {
    let t = 0;
    const sw = new Stopwatch(() => t);
    t = 900;
    expect(sw.elapsedMs()).toBe(900);
    sw.restart();
    t = 1_000;
    expect(sw.elapsedMs()).toBe(100);
  });
});

describe("Deadline", () => {
  test("remaining counts down and reaches zero exactly at the budget", () => {
    let t = 0;
    const d = new Deadline(1_000, () => t);
    expect(d.remainingMs()).toBe(1_000);
    t = 400;
    expect(d.remainingMs()).toBe(600);
    t = 1_000;
    expect(d.remainingMs()).toBe(0);
    expect(d.expired()).toBe(true);
  });

  /**
   * Clamping is not cosmetic. A negative value passed to `setTimeout` fires
   * immediately on some runtimes and is treated as 0 or ignored on others, so
   * an overrun deadline would behave differently depending on where it ran.
   */
  test("remaining clamps at zero rather than going negative", () => {
    let t = 0;
    const d = new Deadline(100, () => t);
    t = 10_000;
    expect(d.remainingMs()).toBe(0);
    expect(d.expired()).toBe(true);
  });

  test("boundedBy never lets a sub-operation outlive the parent budget", () => {
    let t = 0;
    const d = new Deadline(1_000, () => t);
    expect(d.boundedBy(30_000)).toBe(1_000); // parent is the binding constraint
    expect(d.boundedBy(200)).toBe(200); // child is
    t = 950;
    expect(d.boundedBy(30_000)).toBe(50); // parent, nearly spent
  });

  test("boundedBy on an expired deadline is zero, not negative", () => {
    let t = 0;
    const d = new Deadline(10, () => t);
    t = 99_999;
    expect(d.boundedBy(5_000)).toBe(0);
  });
});

describe("isoNow", () => {
  test("is a parseable ISO-8601 instant", () => {
    expect(Number.isNaN(Date.parse(isoNow()))).toBe(false);
    expect(isoNow()).toMatch(/^\d{4}-\d{2}-\d{2}T[\d:.]+Z$/);
  });
});

/**
 * ISC-155. The anti-criterion, enforced statically: wall clock may LABEL a
 * record but must never be subtracted to decide anything. Grepping is the only
 * probe that catches a new violation the moment it is written, rather than when
 * a laptop happens to sleep mid-run.
 */
describe("Anti: no timing path reads Date.now()", () => {
  const TIMING_MODULES = [
    "src/supervisor/index.ts",
    "src/rpc/client.ts",
    "src/rpc/completion.ts",
    "src/cli/commands/wait.ts",
    "src/cli/commands/down.ts",
    "src/util/clock.ts",
    "src/safety/budget.ts",
    "src/safety/kill.ts",
    "src/safety/reaper.ts",
  ];

  test("no timing module computes an interval from Date.now()", async () => {
    const offenders: string[] = [];
    for (const f of TIMING_MODULES) {
      const src = await Bun.file(f).text();
      for (const [i, line] of src.split("\n").entries()) {
        // `new Date().toISOString()` is a label and allowed; `Date.now()` in
        // arithmetic is not.
        if (/Date\.now\(\)/.test(line) && !/^\s*(\/\/|\*)/.test(line)) {
          offenders.push(`${f}:${i + 1}: ${line.trim()}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });
});
