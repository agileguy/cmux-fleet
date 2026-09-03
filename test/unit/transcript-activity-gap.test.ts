/**
 * ISC-492 — the hole in `transcript_activity` that its own closing evidence
 * could not see.
 *
 * ## This does not falsify the 2026-09-01 fix
 *
 * That fix (`contracts.ts:306-380`, `supervisor/index.ts:1982-2020`) is correct
 * about everything it examined. `transcriptNote` (`status.ts:48-80`) keeps three
 * facts apart that must never collapse, `status-transcript-activity.test.ts`
 * pins all three, and a `tui` worker WITH a session file is reported honestly
 * today. **The fix is incomplete, in a way its closing evidence structurally
 * could not reach**: the evidence was gathered against a pane that was visibly
 * mid-turn, and a pane mid-turn HAS a session file. Every fixture that could
 * have exposed this had already passed the branch that skips the write.
 *
 * ## The gap, stated exactly
 *
 * The transcript poll reaches `discoverSessionPath` and **returns** when nothing
 * matches (`supervisor/index.ts:1982`), 76 lines before the only assignment to
 * the field (`:2058`). A `tui` worker whose `sessions/` directory is empty
 * therefore never has `transcript_activity` written at all. Measured on this
 * host: four live attended workers carried `null` for nine hours, and `null` is
 * also what an `rpc` worker carries, so on every surface reading `state.json`
 * alone the two are **the same bytes**. `session_present` does not rescue it —
 * it is `false` for both.
 *
 * ## Why this file exists even if the monitor never ships
 *
 * The gap is in the FIELD's contract, not in any viewer. A monitor that reads
 * `presentation.json` and `attended.json` can tell the two apart without the
 * supervisor changing anything (that is ISC-481, and it is satisfied in
 * `monitor-activity.test.ts`) — but every existing consumer of `state.json`
 * still cannot, and adding a second reader does not repair the first.
 *
 * ## What is asserted, and the shape of the second half
 *
 * Two things, and they are deliberately different kinds of claim:
 *
 *   1. **The contract already has room for the distinction.** No schema change
 *      is needed — `{ entries: 0, last_growth_at: null }` is a legal value that
 *      `transcriptNote` already renders differently from `null`. This is a
 *      permanent assertion about the vocabulary.
 *   2. **The writer does not yet use that room.** This is a TRIPWIRE, pinned to
 *      the blocker's presence rather than to the repair's absence, so that
 *      closing the gap turns it RED and forces whoever closes it to come here
 *      and delete a test that explains what changed. A criterion whose probe
 *      cannot notice its own repair is a criterion that silently stops meaning
 *      anything.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { transcriptNote } from "../../src/cli/commands/status.ts";
import { stripComments } from "../support/source-structure.ts";

const NOW = Date.parse("2026-09-01T06:10:00.000Z");

/**
 * The two workers as they exist on this host, described by ALL the facts on
 * disk — not only the ones `state.json` holds.
 *
 * The `adopted_terminal` and `attended_mode` fields live in `presentation.json`
 * and `attended.json`. They are carried here precisely so the assertions below
 * can be about a PROJECTION rather than about two identical literals: the two
 * workers genuinely differ, and the claim under test is that the difference
 * does not survive the trip through `state.json`.
 */
interface WorkerOnDisk {
  readonly adopted_terminal: boolean;
  readonly attended_mode: "tui" | null;
  readonly session_present: boolean;
  readonly transcript_activity: { entries: number; last_growth_at: string | null } | null;
}

const rpcWorkerToday: WorkerOnDisk = {
  adopted_terminal: false,
  attended_mode: null,
  session_present: false,
  transcript_activity: null,
};

/** Finding A. Four of these were live on this host, silent for nine hours. */
const tuiNoSessionFileToday: WorkerOnDisk = {
  adopted_terminal: true,
  attended_mode: "tui",
  session_present: false,
  transcript_activity: null,
};

/**
 * Everything a consumer of `state.json` can see, and nothing else. `status`,
 * `wait`, `report` and the ledger all read through this keyhole.
 */
const asStateJson = (w: WorkerOnDisk) => ({
  session_present: w.session_present,
  transcript_activity: w.transcript_activity,
});

describe("the defect: two different workers project to the same state.json", () => {
  test("the workers really are different, so there is something to lose", () => {
    // Asserted first, because the next test is only interesting if this one
    // holds. A pair of identical fixtures would make the collapse below a
    // tautology rather than a finding.
    expect(tuiNoSessionFileToday).not.toEqual(rpcWorkerToday);
  });

  /**
   * THE FINDING, stated so that it stops being true the moment someone repairs
   * it. A reader tempted to fix this by consulting some OTHER `state.json`
   * field has to make this test fail first — and there is no such field to
   * reach for, which is exactly why SRD §9 Q1(a) had to go outside `state.json`
   * to answer the question at all.
   */
  test("but state.json alone cannot separate them", () => {
    expect(asStateJson(tuiNoSessionFileToday)).toEqual(asStateJson(rpcWorkerToday));
  });

  test("so every surface reading only that field renders them identically", () => {
    // `transcriptNote` is correct here and still cannot help: it is being handed
    // the same input twice. The defect is upstream of the renderer, which is why
    // ISC-492 is filed against the field rather than against any viewer.
    expect(transcriptNote(tuiNoSessionFileToday.transcript_activity, NOW)).toBe(
      transcriptNote(rpcWorkerToday.transcript_activity, NOW),
    );
    expect(transcriptNote(rpcWorkerToday.transcript_activity, NOW)).toBeNull();
  });
});

/**
 * ISC-492's own assertion: the two ARE distinguishable, expressed against the
 * existing field contract and requiring no change to it.
 */
describe("ISC-492: the contract already distinguishes them, unchanged", () => {
  /**
   * The value the poll should be writing when it is watching a `tui` worker
   * whose `sessions/` directory is empty.
   *
   * This is not a new shape. `entries: 0` is legal under
   * `WorkerStateSchema.transcript_activity` (`contracts.ts:380-387`), and
   * `last_growth_at: null` already means MEASURED-AND-NEVER-GREW rather than not
   * measured — the docblock spells that out at `contracts.ts:370-375` for the
   * case of a supervisor started against an existing transcript. A watcher that
   * has looked and found no file is in exactly that epistemic position: it is
   * watching, and it has seen nothing.
   */
  const watchingButNothingSeen = { entries: 0, last_growth_at: null } as const;

  test("a watching tui worker is distinguishable from an unmeasured rpc worker", () => {
    // THE CRITERION. Two fixtures, asserted to differ, in the existing suite's
    // own vocabulary.
    expect(transcriptNote(watchingButNothingSeen, NOW)).not.toBe(
      transcriptNote(rpcWorkerToday.transcript_activity, NOW),
    );
  });

  test("and the difference is the one the field's own docblock already names", () => {
    // NOT MEASURED renders as silence; MEASURED-AND-STILL says so out loud.
    // Both strings are `transcriptNote`'s existing output — no new wording, no
    // schema change, nothing for a consumer to migrate.
    expect(transcriptNote(watchingButNothingSeen, NOW)).toBe("transcript no writes yet");
    expect(transcriptNote(rpcWorkerToday.transcript_activity, NOW)).toBeNull();
  });

  /**
   * The repair must not overshoot into the opposite lie. `entries: 0` with a
   * growth stamp would claim the worker wrote something, and `phase: busy` is
   * the mistake `contracts.ts:306-330` already argues against on the staged
   * route. The honest write is "watching, nothing seen", which is what the
   * value above says and all it says.
   */
  test("the honest value claims no writes, so it cannot be read as liveness", () => {
    expect(watchingButNothingSeen.last_growth_at).toBeNull();
    expect(watchingButNothingSeen.entries).toBe(0);
  });
});

/**
 * The tripwire.
 *
 * Comment-stripped for the reason `source-structure.ts` exists: this file's own
 * header names `if (found.path === null) return` in prose, and a raw grep would
 * find the docstring that describes a control just as happily as the code that
 * implements it.
 */
describe("the writer does not yet use the room the contract has", () => {
  const SUPERVISOR = stripComments(
    readFileSync(new URL("../../src/supervisor/index.ts", import.meta.url).pathname, "utf8"),
  );

  /**
   * **WHEN THIS TEST FAILS, THE GAP IS CLOSED — DELETE THIS `describe` BLOCK.**
   *
   * It is pinned to the BLOCKER's presence on purpose. A probe asserting the
   * repair's absence in some looser way would stay green through a partial fix;
   * this one fails the moment the early return stops preceding the write, which
   * is the only edit that can close the gap.
   */
  test("the poll still returns before ever writing the field", () => {
    const earlyReturn = SUPERVISOR.indexOf("if (found.path === null) return;");
    const fieldWrite = SUPERVISOR.indexOf("state.transcript_activity = {");

    expect(earlyReturn).toBeGreaterThan(-1);
    expect(fieldWrite).toBeGreaterThan(-1);
    // The ordering IS the defect: every path that reaches the write has already
    // proved a session file exists, so no `tui` worker without one can be
    // measured. `supervisor/index.ts:1982` versus `:2058`.
    expect(earlyReturn).toBeLessThan(fieldWrite);
  });

  test("and there is exactly one site that writes it, so the gap has one repair", () => {
    // Two write sites would mean the early return might be bypassed by the
    // other one, and this whole file would be reasoning about the wrong branch.
    expect([...SUPERVISOR.matchAll(/state\.transcript_activity = /g)]).toHaveLength(1);
  });
});
