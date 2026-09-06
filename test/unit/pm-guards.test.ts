import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  confirmDispatchStarted,
  testerCloneCoversMerge,
  type ConfirmDispatchInput,
} from "../../src/run/pm-guards.ts";

/* ────────────────────────────────────────────────────────────────────────────
 * ISC-547
 * ──────────────────────────────────────────────────────────────────────────── */

const ACCEPTED = JSON.stringify({
  accepted: true,
  task_id: "T-phase-3-eng-1",
  worker: "eng-1",
  epoch: 1,
  via: "staged",
});

/**
 * A status snapshot in which the worker holds EXACTLY what is asked for.
 *
 * Everything else in this file varies away from this one fixture, which is the
 * discipline `feedback_degenerate_fixtures_hide_narrowing` names: a check that
 * only ever sees agreement between the payload and the fleet is a check that
 * cannot tell which of the two it read.
 */
function statusHolding(over: {
  id?: string;
  phase?: string | null;
  task_id?: string | null;
  staged_task_id?: string | null;
}): string {
  return JSON.stringify({
    run_id: "2026-09-06T02-00-00Z-aaaa",
    workers: [
      {
        id: over.id ?? "eng-1",
        alive: true,
        phase: over.phase ?? "busy",
        task_id: over.task_id ?? null,
        staged_task_id: over.staged_task_id ?? null,
        epoch: 1,
      },
      // A bystander, so "found the row" is never the same statement as "there
      // is exactly one row".
      { id: "eng-2", alive: true, phase: "idle", task_id: null, staged_task_id: null, epoch: 0 },
    ],
  });
}

const base: ConfirmDispatchInput = {
  worker: "eng-1",
  taskId: "T-phase-3-eng-1",
  dispatchStdout: ACCEPTED,
  statusJson: statusHolding({ task_id: "T-phase-3-eng-1" }),
};

describe("a dispatch that did not land is never reported as one", () => {
  test("a runner that returned EMPTY is refused, not confirmed", () => {
    /*
     * ISC-547's probe verbatim: wire the dispatch dep to a runner that returns
     * empty. This is the measured shape — a subprocess helper documented as
     * "swallowing failure" with `stderr: "ignore"` returns "" for a command
     * that exited 2 — and the console printed "dispatched" over it.
     */
    const r = confirmDispatchStarted({ ...base, dispatchStdout: "" });
    expect(r.started).toBe(false);
    expect(r.state).toBe("refused");
    expect(r.detail).toContain("did not land");
    expect(r.detail).toContain("discards a failing exit status");
  });

  test("whitespace-only output is the same failure as empty", () => {
    const r = confirmDispatchStarted({ ...base, dispatchStdout: "  \n \t " });
    expect(r.started).toBe(false);
    expect(r.state).toBe("refused");
  });

  test("output that is not JSON is refused", () => {
    const r = confirmDispatchStarted({ ...base, dispatchStdout: "error: worker unreachable" });
    expect(r.started).toBe(false);
    expect(r.detail).toContain("not the JSON --json promises");
  });

  test("accepted:false is refused even though the command exited 0", () => {
    const r = confirmDispatchStarted({
      ...base,
      dispatchStdout: JSON.stringify({ accepted: false, reason: "stale epoch" }),
    });
    expect(r.started).toBe(false);
    expect(r.state).toBe("refused");
    expect(r.detail).toContain("accepted is false");
  });

  /**
   * THE FIXTURE THE WHOLE FUNCTION TURNS ON.
   *
   * The payload is the happy one — `accepted: true`, `via: "staged"`, exit 0 —
   * and the fleet does not show the task. If this case were missing, an
   * implementation that returned `started: true` the moment `dispatchProblem`
   * came back `null` would pass every other test in this describe, because
   * every one of them either has a refused payload or a status that agrees
   * with it. §8.2 step 3: the JSON cannot tell you the turn never started.
   */
  test("an accepted payload the fleet does not corroborate is UNCONFIRMED", () => {
    const r = confirmDispatchStarted({
      ...base,
      statusJson: statusHolding({ phase: "idle", task_id: null, staged_task_id: null }),
    });
    expect(r.started).toBe(false);
    expect(r.state).toBe("unconfirmed");
    expect(r.detail).toContain("holding nothing");
  });

  test("a worker holding a DIFFERENT task is unconfirmed, and the other id is named", () => {
    const r = confirmDispatchStarted({
      ...base,
      statusJson: statusHolding({ task_id: "T-phase-2-eng-1" }),
    });
    expect(r.started).toBe(false);
    expect(r.detail).toContain("T-phase-2-eng-1");
  });

  test("a worker status does not list at all is unconfirmed, and the roster is named", () => {
    const r = confirmDispatchStarted({ ...base, worker: "tst-1" });
    expect(r.started).toBe(false);
    expect(r.state).toBe("unconfirmed");
    expect(r.detail).toContain("eng-1, eng-2");
  });

  test("unreadable status is unconfirmed rather than assumed either way", () => {
    const r = confirmDispatchStarted({ ...base, statusJson: "{" });
    expect(r.started).toBe(false);
    expect(r.state).toBe("unconfirmed");
    expect(r.detail).toContain("could not be read");
  });

  test("busy and holding the task is started", () => {
    const r = confirmDispatchStarted(base);
    expect(r.started).toBe(true);
    expect(r.state).toBe("started");
  });

  /**
   * ISC-551's probe, verbatim. The dispatch payload is `{accepted: true, via:
   * "staged"}` and the worker is `idle` with a `staged_task_id` — and the turn
   * is NOT started.
   *
   * The distinction the criterion is defending: `via: "staged"` IS success for
   * the question *did the envelope land*, and the fleet skill is right that
   * re-dispatching on it is a mistake. It is not an answer to *did the turn
   * start*, and the accepted payload carries no field that separates the two.
   */
  test("idle with the task STAGED is NOT started, and says so without crying failure", () => {
    const r = confirmDispatchStarted({
      ...base,
      statusJson: statusHolding({ phase: "idle", staged_task_id: "T-phase-3-eng-1" }),
    });
    expect(r.started).toBe(false);
    expect(r.state).toBe("staged");
    expect(r.detail).toContain("DO NOT re-dispatch");
  });

  /**
   * Anti-degenerate: staged must not collapse into either neighbour. Without
   * this, an implementation that answered every non-busy case `unconfirmed`
   * would satisfy the test above on `started` alone, and the workflow would be
   * told to fix an envelope that is perfectly fine.
   */
  test("staged is its own state — neither started nor a failure", () => {
    const staged = confirmDispatchStarted({
      ...base,
      statusJson: statusHolding({ phase: "idle", staged_task_id: "T-phase-3-eng-1" }),
    });
    const nothing = confirmDispatchStarted({
      ...base,
      statusJson: statusHolding({ phase: "idle", task_id: null, staged_task_id: null }),
    });
    const busy = confirmDispatchStarted(base);
    expect([busy.state, staged.state, nothing.state]).toEqual(["started", "staged", "unconfirmed"]);
  });

  /**
   * The relationship between the two copies of `dispatchProblem`, asserted
   * rather than remembered. `pm-guards.ts` restates the arms instead of
   * importing a private helper across a boundary with no other reason to
   * exist; that is only safe while the arms agree, so their agreement is what
   * gets checked. The sentinel strings are the observable part of each arm.
   */
  test("both copies of the dispatch-refusal arms carry the same three sentinels", async () => {
    const dir = join(import.meta.dir, "..", "..", "src", "run");
    const fresh = await readFile(join(dir, "fresh-dispatch.ts"), "utf8");
    const guards = await readFile(join(dir, "pm-guards.ts"), "utf8");
    const sentinels = [
      "it produced no output at all, which is what a runner that discards a failing exit status returns",
      "its output is not the JSON --json promises",
      "it was refused — accepted is",
    ];
    for (const s of sentinels) {
      expect(fresh.includes(s), `fresh-dispatch.ts lost the arm: ${s}`).toBe(true);
      expect(guards.includes(s), `pm-guards.ts lost the arm: ${s}`).toBe(true);
    }
  });
});

/* ────────────────────────────────────────────────────────────────────────────
 * ISC-555
 * ──────────────────────────────────────────────────────────────────────────── */

const MERGE_A = "1111111111111111111111111111111111111111";
const MERGE_B = "2222222222222222222222222222222222222222";
const OLD_BASE = "9999999999999999999999999999999999999999";

describe("a tester whose clone predates the integration merge is refused", () => {
  /**
   * The asymmetric fixture, written before trusting anything below it.
   *
   * A clone that contains every merge and a clone that contains none are not
   * enough on their own: a phase merges one worker at a time, so the real
   * hazard is a tester restarted BETWEEN two merges, whose clone covers the
   * first and not the second. Every "all" and "none" assertion in this
   * describe is only meaningful because this case is here to separate them.
   */
  test("a clone holding the FIRST merge and not the SECOND is refused", () => {
    const r = testerCloneCoversMerge(
      { worker: "tst-1", cloneBaseSha: MERGE_A, mergeCommits: [MERGE_A, MERGE_B] },
      (c) => c === MERGE_A,
    );
    expect(r.fresh).toBe(false);
    expect(r.fresh === false && r.missing).toEqual([MERGE_B]);
    expect(r.detail).toContain("1 of 2");
    expect(r.detail).toContain(MERGE_B.slice(0, 12));
    expect(r.detail).not.toContain(MERGE_A.slice(0, 12) + ",");
  });

  /**
   * The MIRROR of the case above, and the one that actually pins "every merge
   * commit" rather than "the last one".
   *
   * Added after a mutation found the gap: replacing the scan with a tip-only
   * check left the first fixture green, because there the missing commit IS
   * the tip. A clone covering the tip and not an earlier merge is the shape
   * that separates the two implementations, and it is a real shape — merges
   * land one worker at a time, and a tester restarted mid-sequence sees them
   * out of order relative to its own clone time.
   */
  test("a clone holding the SECOND merge and not the FIRST is refused", () => {
    const r = testerCloneCoversMerge(
      { worker: "tst-1", cloneBaseSha: MERGE_B, mergeCommits: [MERGE_A, MERGE_B] },
      (c) => c === MERGE_B,
    );
    expect(r.fresh).toBe(false);
    expect(r.fresh === false && r.missing).toEqual([MERGE_A]);
    expect(r.detail).toContain(MERGE_A.slice(0, 12));
  });

  test("a clone from before the phase is refused and told to restart", () => {
    const r = testerCloneCoversMerge(
      { worker: "tst-1", cloneBaseSha: OLD_BASE, mergeCommits: [MERGE_A, MERGE_B] },
      () => false,
    );
    expect(r.fresh).toBe(false);
    expect(r.fresh === false && r.missing).toEqual([MERGE_A, MERGE_B]);
    expect(r.detail).toContain("OLDER than this phase's integration merge");
    expect(r.detail).toContain("Restart the tester");
    // The reason a restart is the ONLY remedy, said in the refusal itself.
    expect(r.detail).toContain("no remotes");
  });

  test("a clone containing every merge is fresh", () => {
    const r = testerCloneCoversMerge(
      { worker: "tst-1", cloneBaseSha: MERGE_B, mergeCommits: [MERGE_A, MERGE_B] },
      () => true,
    );
    expect(r.fresh).toBe(true);
    expect(r.detail).toContain("contains all 2 merge commit(s)");
  });

  test("a clone whose base IS the only merge commit is fresh", () => {
    // `git merge-base --is-ancestor X X` is true: a tester cloned at the
    // moment of the merge holds it.
    const r = testerCloneCoversMerge(
      { worker: "tst-2", cloneBaseSha: MERGE_A, mergeCommits: [MERGE_A] },
      (c) => c === MERGE_A,
    );
    expect(r.fresh).toBe(true);
  });

  test("a phase that merged nothing cannot make a tester stale", () => {
    /*
     * Anti-degenerate in the other direction. An implementation that refused
     * whenever it could not prove freshness would fail here, and a phase whose
     * engineers produced no mergeable work is an ordinary outcome, not a
     * reason to refuse the tester that would confirm it.
     */
    const r = testerCloneCoversMerge(
      { worker: "tst-1", cloneBaseSha: OLD_BASE, mergeCommits: [] },
      () => {
        throw new Error("ancestry must not be consulted when there is nothing to cover");
      },
    );
    expect(r.fresh).toBe(true);
  });

  test("the ancestry answer is asked once per merge commit and for nothing else", () => {
    const asked: string[] = [];
    testerCloneCoversMerge(
      { worker: "tst-1", cloneBaseSha: OLD_BASE, mergeCommits: [MERGE_A, MERGE_B] },
      (c) => {
        asked.push(c);
        return true;
      },
    );
    expect(asked).toEqual([MERGE_A, MERGE_B]);
  });
});
