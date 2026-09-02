/**
 * ISC-455 — no criterion in ISC-431..ISC-459 requires a real pty.
 *
 * ## Why the block filed its own grading standard as a criterion
 *
 * ISC-377, ISC-378, ISC-379 and ISC-387 are all graded `[~]`, and all four for
 * the same reason: *"the mode's subject is a pseudo-TTY and the suites cannot
 * open one."* They are not wrong, they are unverifiable, and a criterion that
 * can never be re-checked is a claim that decays silently into whatever the
 * code happens to do next.
 *
 * The staged-dispatch block was written to avoid joining them, and §10 of the
 * SRD asks for that property to be declared **at filing time rather than
 * discovered at grading time**. This file is the declaration made checkable.
 *
 * ## What is asserted, and the weakness that is admitted
 *
 * Two things, and the first matters more than it looks: **every file in the
 * list must exist.** A hand-written list is the maintenance hazard here — a
 * renamed file would silently shrink the set and this probe would keep passing
 * over fewer and fewer files, which is the shape of a check that reports on its
 * own instrumentation. So a missing file is a failure, not a skip.
 *
 * Second, none of them may need a terminal or a container: no `PIFLEET_DOCKER`
 * gate (the mechanism by which a suite opts out of running), no pty library,
 * and no spawning of `docker` itself. **`-t` in a fixture is fine and is
 * present** — `staged-harvest.test.ts` writes a launch record whose argv
 * carries it, because `launchPaneMode` reads that mark to decide a route. It
 * writes the string; nothing runs it. A probe that banned the characters rather
 * than the execution would fail on a fixture and prove nothing.
 *
 * **What this cannot prove** is that the criteria are GOOD, only that they are
 * runnable everywhere. A block of trivial criteria would pass this easily.
 * That is why it is filed as an anti-criterion beside the others rather than
 * instead of them.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

const ROOT = new URL("../../", import.meta.url).pathname;

/**
 * Every file carrying a probe for ISC-431..ISC-459.
 *
 * Listed rather than globbed, because a glob would quietly include whatever
 * else lands in these directories and quietly exclude a probe that moved. The
 * existence assertion below is what makes the list self-checking.
 */
const BLOCK_FILES = [
  "test/unit/dispatch-pane-route.test.ts", // ISC-431
  "test/unit/attempt-id.test.ts", // ISC-458
  "test/unit/dispatch-policy.test.ts", // ISC-437, ISC-438
  "test/unit/stage-verb.test.ts", // ISC-439..444, ISC-456, ISC-457
  "test/unit/staged-visibility.test.ts", // ISC-445, ISC-457, ISC-459
  "test/unit/staged-trigger.test.ts", // ISC-436
  "test/unit/adopted-terminal-guard.test.ts", // ISC-447, ISC-448
  "test/unit/attach-here.test.ts", // ISC-446, ISC-454
  "test/unit/staged-report.test.ts", // ISC-451, ISC-452
  "test/unit/staged-collect.test.ts", // ISC-451
  "test/unit/staged-auto-refusal.test.ts", // ISC-453
  "test/integration/staged-harvest.test.ts", // ISC-449, ISC-450
] as const;

describe("the whole block runs with no terminal and no container (ISC-455)", () => {
  test("every listed file exists — a rename must redden, not shrink the set", () => {
    const missing = BLOCK_FILES.filter((f) => !existsSync(`${ROOT}${f}`));
    expect(missing, `probe files have moved: ${missing.join(", ")}`).toEqual([]);
    expect(BLOCK_FILES.length).toBeGreaterThanOrEqual(12);
  });

  /**
   * `PIFLEET_DOCKER` is how a suite in this repo says "skip me unless an image
   * is built". A file in this block that reached for it would be opting out of
   * running, which is the `[~]` the block exists to avoid.
   */
  test("no file gates itself behind the Docker env flag", () => {
    for (const f of BLOCK_FILES) {
      expect(readFileSync(`${ROOT}${f}`, "utf8"), `${f} gates on Docker`).not.toContain(
        "PIFLEET_DOCKER",
      );
    }
  });

  test("no file opens a pseudo-terminal", () => {
    for (const f of BLOCK_FILES) {
      const text = readFileSync(`${ROOT}${f}`, "utf8");
      for (const banned of ["node-pty", "openpty", "forkpty", "createPty"]) {
        expect(text, `${f} reaches for a pty via ${banned}`).not.toContain(banned);
      }
    }
  });

  /**
   * EXECUTION, not mention. `staged-harvest.test.ts` writes `-t` and the word
   * `docker` into a launch-record fixture on purpose — `launchPaneMode` reads
   * those marks to decide the route, so the fixture has to carry them. What
   * must not happen is any of these files actually starting a container.
   */
  test("no file spawns docker", () => {
    for (const f of BLOCK_FILES) {
      const text = readFileSync(`${ROOT}${f}`, "utf8");
      // The two spawn idioms this repo uses, with docker as argv[0].
      expect(text, `${f} spawns docker`).not.toContain('Bun.spawn(["docker"');
      expect(text, `${f} spawns docker`).not.toContain('spawn(["docker"');
    }
  });
});
