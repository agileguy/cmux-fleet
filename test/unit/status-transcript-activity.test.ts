/**
 * `status` can tell a busy attended pane from a quiet one.
 *
 * ## The defect
 *
 * Operations console, 2026-09-01. The status pane read
 *
 *     tick-1: idle task=- supervisor=up
 *
 * while the pane beside it was visibly mid-turn — a model at 60.9% of its
 * context window, writing files, its session transcript 300 KB and still
 * growing. Every field on that line was true. `phase` and `task_id` describe an
 * EPOCH, `dispatch` refuses the socket route for a `tui` worker (§3.5), and a
 * pane a person types into therefore holds no pifleet task ever. `idle` was
 * not a stale reading or a dead poll; it was the answer to a question nobody
 * had asked, and it was the only answer that line could ever give for the two
 * panes the console exists to show.
 *
 * ## What is asserted here
 *
 * The two exported pure functions, over the cases that carry the defect, plus
 * the wiring that makes them reach an operator. The wiring probe is not
 * decoration: `transcriptNote` being correct says nothing about the action
 * calling it, and a status line assembled without it looks exactly like the
 * one this file exists to change.
 *
 * The supervisor half — that anything ever WRITES `transcript_activity`, and
 * writes it above the epoch return — is in `supervisor-tui.test.ts`, next to
 * the poll it constrains.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { ago, transcriptNote } from "../../src/cli/commands/status.ts";
import { stripComments } from "../support/source-structure.ts";

const NOW = Date.parse("2026-09-01T06:10:00.000Z");
const at = (iso: string) => ({ entries: 1462, last_growth_at: iso });

describe("ago", () => {
  test("seconds under a minute, and the unit is the point", () => {
    expect(ago("2026-09-01T06:09:57.000Z", NOW)).toBe("3s");
    expect(ago("2026-09-01T06:09:01.000Z", NOW)).toBe("59s");
  });

  test("minutes under an hour", () => {
    expect(ago("2026-09-01T06:09:00.000Z", NOW)).toBe("1m");
    expect(ago("2026-09-01T05:30:00.000Z", NOW)).toBe("40m");
  });

  test("hours above it", () => {
    expect(ago("2026-09-01T05:10:00.000Z", NOW)).toBe("1h");
    expect(ago("2026-08-31T23:10:00.000Z", NOW)).toBe("7h");
  });

  /**
   * The boundaries, because the rounding and the flooring disagree about them
   * and an off-by-one here prints `60s` and `0m`.
   */
  test("60s becomes 1m and 3600s becomes 1h rather than 60s and 60m", () => {
    expect(ago("2026-09-01T06:09:00.000Z", NOW)).toBe("1m");
    expect(ago("2026-09-01T05:10:00.000Z", NOW)).toBe("1h");
  });

  /**
   * A supervisor whose host clock runs a few seconds ahead writes a stamp in
   * the future. `-3s` reads as a bug in pifleet; `0s` reads as "just now",
   * which is what it is.
   */
  test("a future stamp clamps to 0s instead of going negative", () => {
    expect(ago("2026-09-01T06:10:07.000Z", NOW)).toBe("0s");
  });

  test("an unparseable stamp is null, so no caller can print NaN", () => {
    // A hand-edited or truncated state file must not print `NaNs ago`, which
    // reads as a crash rather than as a bad value. Returning `null` rather
    // than a sentinel string makes the caller decide what to SAY, which is
    // where the wording belongs.
    expect(ago("not a timestamp", NOW)).toBeNull();
  });
});

describe("transcriptNote keeps three different facts apart", () => {
  /**
   * THE CASE THE DEFECT WAS. A pane that wrote three seconds ago is working,
   * and the line has to say so next to a `phase` that says `idle`.
   */
  test("a transcript that grew recently reports its age", () => {
    expect(transcriptNote(at("2026-09-01T06:09:57.000Z"), NOW)).toBe("transcript 3s ago");
  });

  test("a transcript that last grew forty minutes ago says forty minutes", () => {
    // The other half of the same assertion, and the reason an AGE is printed
    // rather than a boolean: no threshold in this tree can know whether a
    // 90-second gap is a long tool call or a finished turn, and an operator
    // reading `40m` does not need one.
    expect(transcriptNote(at("2026-09-01T05:30:00.000Z"), NOW)).toBe("transcript 40m ago");
  });

  /**
   * MEASURED-AND-STILL is not the same claim as NOT-MEASURED, and collapsing
   * them is how this field would come to lie the way `phase` did.
   *
   * A supervisor that started against an existing transcript has a count and
   * no growth. Something is watching, and it has seen nothing.
   */
  test("watched but never grown is its own message, not an age", () => {
    expect(transcriptNote({ entries: 900, last_growth_at: null }, NOW)).toBe(
      "transcript no writes yet",
    );
  });

  /**
   * `null` is an `rpc` worker, whose `phase` already answers the question
   * honestly, and it must produce NOTHING rather than a zero.
   *
   * Rendering it as `transcript no writes yet` would annotate every rpc worker
   * in the fleet with a column about a mechanism it does not use, and would
   * read as an rpc worker sitting dead.
   */
  test("an unmeasured worker gets no note at all", () => {
    expect(transcriptNote(null, NOW)).toBeNull();
  });

  /**
   * A corrupt stamp says so instead of being aged.
   *
   * The alternative shape — falling back to "no writes yet" — would report a
   * DAMAGED state file as a quiet worker, which is the collapse the three
   * cases above exist to prevent, arriving through the error path.
   */
  test("a stamp that will not parse is reported as unreadable, not as quiet", () => {
    expect(transcriptNote({ entries: 12, last_growth_at: "garbage" }, NOW)).toBe(
      "transcript last write unreadable",
    );
  });
});

/**
 * The wiring — the same shape of probe, and for the same reason, as the
 * live-run selector's in `status-live-run.test.ts`: deleting the call from the
 * action leaves every assertion above green while the pane goes back to
 * printing exactly the line that started this.
 */
describe("the status action actually prints the note", () => {
  const SRC = stripComments(
    readFileSync(new URL("../../src/cli/commands/status.ts", import.meta.url).pathname, "utf8"),
  );

  test("the text line appends it, and appends nothing when there is none", () => {
    expect(SRC).toMatch(/transcriptNote\(w\.state\?\.transcript_activity \?\? null, nowMs\)/);
    // The empty-string branch is what makes an `rpc` worker's line byte-identical
    // to what it was before this change — asserted rather than assumed, because
    // a `${note}` interpolated unguarded would print the literal `null`.
    expect(SRC).toMatch(/note === null \? "" :/);
    expect(SRC).toMatch(/supervisor=\$\{live\}\$\{suffix\}/);
  });

  test("`--json` carries the field too", () => {
    // A pane is one consumer. A script asking whether the fleet is doing
    // anything must not have to parse the human line to find out.
    expect(SRC).toMatch(/transcript_activity: w\.state\?\.transcript_activity \?\? null/);
  });

  /**
   * ONE clock reading for the whole loop.
   *
   * With `Date.now()` called per worker, two panes whose transcripts last grew
   * in the same second can print different ages because the loop reached the
   * second one a moment later. It is a small wrong, and it is the kind that
   * makes an operator distrust the column.
   */
  test("every worker in a snapshot is aged against the same instant", () => {
    expect(SRC).toMatch(/const nowMs = Date\.now\(\);/);
    expect([...SRC.matchAll(/Date\.now\(\)/g)]).toHaveLength(1);
  });
});
