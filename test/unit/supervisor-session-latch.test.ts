/**
 * ISC-281's first arm, pinned structurally: the session-presence latch runs at
 * WRITE time, not on the heartbeat's schedule.
 *
 * ## Why this needs a structural probe at all
 *
 * `test/integration/supervisor.test.ts` already proves the latch WORKS — the
 * flag flips, once, and names the right path. That probe passes equally well
 * against the implementation this criterion replaced, where the check lived
 * inline in a 250 ms interval. Both flip the flag; they differ only in how
 * long a reader can observe a stale `false`, and the whole of ISC-281 is about
 * that window. A behavioural test cannot separate them without asserting on
 * timing, and a timing assertion under a loaded CI runner is a test that gets
 * loosened until it cannot fail.
 *
 * So the property asserted here is the one that is actually observable in the
 * source: the latch is called from inside the write chain, immediately before
 * the state is serialized, and it exists in exactly one place.
 *
 * ## Why ONE call site is the load-bearing claim
 *
 * It is what makes the behavioural probe able to fail. With the check in two
 * places, deleting the write-chain copy leaves the heartbeat quietly covering
 * for it, the integration test stays green, and the criterion silently
 * regresses to the behaviour it was filed against. With one, deleting it
 * disables the latch outright and the behavioural probe goes red. The two
 * tests are a pair, and this is the half that keeps the other honest.
 *
 * Comment-stripped, for the usual reason: this module explains the check in
 * prose at length, so a grep for the identifier passes on a file that no
 * longer performs it.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { stripComments } from "../support/source-structure.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SUPERVISOR = stripComments(readFileSync(`${ROOT}src/supervisor/index.ts`, "utf8"));

describe("ISC-281: the session-presence latch is on the write path", () => {
  test("the latch runs immediately before the state is serialized", () => {
    // Adjacency, not mere co-presence. `noteSessionFilePresent()` sitting
    // anywhere in the file would satisfy a `.includes` check while doing
    // nothing for the flag a reader is about to load — the value has to be
    // computed on the way INTO the write.
    expect(SUPERVISOR).toMatch(
      /noteSessionFilePresent\(\);\s*return\s+writeWorkerState\(wp,\s*state\);/,
    );
  });

  test("there is exactly one place that stats the recorded session path", () => {
    const checks = [...SUPERVISOR.matchAll(/existsSync\(state\.session_path\)/g)];
    expect(
      checks.length,
      `${checks.length} places stat state.session_path. A second one — the heartbeat's, ` +
        `historically — makes the write-chain check deletable with every test still green, ` +
        `which is exactly how this criterion regresses without anyone noticing.`,
    ).toBe(1);
  });

  test("the heartbeat no longer carries its own copy", () => {
    // The interval body, from the timer's opening brace to `}, HEARTBEAT_MS)`.
    const hb = /setInterval\(\(\)\s*=>\s*\{([\s\S]*?)\},\s*HEARTBEAT_MS\)/.exec(SUPERVISOR);
    expect(hb, "the heartbeat interval could not be located — this guard is not reading it").not.toBeNull();
    const body = hb![1] ?? "";
    expect(body).not.toContain("session_present");
    expect(body).not.toContain("session_file_present");
    // …and it does still flush, which is what carries the latch's result to
    // disk on an idle worker that is emitting no other state writes.
    expect(body).toContain("flushState()");
  });

  /**
   * The latch's single-fire guard, asserted on the source because the
   * behavioural probe can only observe it over the life of one short test. A
   * missing guard logs one `session_file_present` per flush, forever.
   */
  test("the latch returns early once it has already fired", () => {
    const fn = /const noteSessionFilePresent = \(\): void => \{([\s\S]*?)\n  \};/.exec(SUPERVISOR);
    expect(fn, "noteSessionFilePresent moved or was renamed").not.toBeNull();
    const body = fn![1] ?? "";
    expect(body).toMatch(/if \(state\.session_path === null \|\| state\.session_present\) return;/);
    expect(body).toContain("state.session_present = true;");
  });
});
