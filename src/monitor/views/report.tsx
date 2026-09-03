/**
 * VIEW 4 — RUN REPORT: a frame around `renderRunReport`'s own output
 * (SRD-FLEET-MONITOR §6.2 View 4, §6.5, D10, D13, ISC-503, ISC-505).
 *
 * ## THIS FILE FORMATS NOTHING, AND THAT IS ITS ENTIRE SPECIFICATION
 *
 * `model.report` is `Region<readonly string[]>` — already rendered, by
 * `renderRunReport` (`report/render.ts`), before it reached the model
 * (`model.ts:216-230`). §6.2 requires the report "in `renderRunReport`'s own
 * order and with its own wording rules preserved", naming two of them: attended
 * first, and `"would merge cleanly … as of this check — NOT merged"` VERBATIM.
 *
 * So this file does not parse a line, does not recognise a heading, does not
 * re-order, re-indent, re-colour by content, or re-wrap on a rule of its own.
 * **The moment it looks at what a line SAYS, it has become a second renderer of
 * one fact and the two spellings can drift** — and the spelling that would drift
 * is the one `report/render.ts:8-12` exists to protect: a reader skimming for
 * "clean" must not be able to walk away believing something landed. There is
 * exactly one thing this file knows about the lines: how many there are.
 *
 * The temptation is real and worth naming, because it looks like an
 * improvement. A `##` prefix is a markdown heading; colouring those cyan would
 * make the report scan better in a pane. It is refused: recognising `##` is
 * parsing, the set of prefixes `renderRunReport` emits is its business and
 * changes when it changes, and a frame that highlighted four of five section
 * headers would be worse than one that highlighted none.
 *
 * ## What it renders from
 *
 * `model.report` and `model.view.runId`. Not `model.runs`, and not
 * `model.history` — which matters here more than in views 2 and 3, because a
 * run report is HISTORIC by nature (§6.2) and both of those regions describe
 * the present. A frame that took its run label from the fleet region would go
 * blank the moment the run it is reporting on finished.
 *
 * ## PAGINATION IS NOT IMPLEMENTED, AND THE REASON IS THE CONTRACT
 *
 * A paginated view needs two things the frozen `FleetModel` does not carry: a
 * HEIGHT, and a page index in the selection. `FleetModel` has `columns` and no
 * rows (`model.ts:193-231`), and `ViewState`'s report arm carries a `runId` and
 * nothing else (`model.ts:356-360`) — so there is no state a page could be kept
 * in and no number a page could be sized against. §6.5's height ladder ("the
 * git strip collapses to one line, then the history hint disappears, then rows
 * scroll") is unimplementable in every view for the same reason.
 *
 * **What this file does instead of pretending: it names the line count in the
 * heading.** A frame that showed the first N lines of a long report with no
 * count is the silent-truncation failure ISC-504 is filed against, in the one
 * view where the content is most likely to be long. A frame that shows all of
 * them and says how many is honest about what it is: the pane scrolls, not the
 * view.
 */

import { Box } from "ink";

import type { Region } from "../model.ts";
import {
  BodyLine,
  FloorRefusal,
  RegionHeading,
  Rule,
  deriveFloor,
  regionLine,
  usePalette,
} from "./chrome.tsx";

/**
 * The body gutter, and the only column this view owns.
 *
 * Two spaces, matching every other view's body indent, so a report line and a
 * fleet row start at the same place when an operator flips between them.
 */
const GUTTER = 2;

/**
 * The narrowest content this view will draw into: one column.
 *
 * Below `GUTTER + 1` the gutter consumes the pane and every report line renders
 * as whitespace — a view showing blank lines where a merge warning was, which
 * is the worst frame in this design because it looks like a report with nothing
 * in it.
 */
const MIN_CONTENT = 1;

/**
 * The floor, derived by the same rule as views 1-3 — AND IT IS SMALL, WHICH IS
 * THE RULE'S HONEST OUTPUT RATHER THAN AN OVERSIGHT (ISC-505).
 *
 * `chrome.tsx` states the rule: a floor is the width of the cells a view may
 * not drop, and full-width lines are not counted because they wrap or truncate
 * on their own and do not have to fit beside anything. **View 4 is built
 * entirely out of full-width lines**, so the only thing it can honestly count
 * is its own gutter plus one column of content, and the floor is 3.
 *
 * A larger number was considered and refused twice, both times for the same
 * reason. Deriving it from the deepest indent `renderRunReport` emits would
 * encode that renderer's internal layout here — a second spelling of the thing
 * this file exists not to know. Deriving it from the fixed skeleton of the
 * `"would merge cleanly … NOT merged"` sentence would put that wording in this
 * file as a literal, which is precisely the drift §6.2 pins it against. **A
 * floor picked to look substantial would be exactly the invented number ISC-485
 * refused when it closed Q3 by derivation instead of by probing a terminal.**
 *
 * **The 3 is not what ships, and the reason is a defect the ISC-505 sweep
 * found rather than one that was reasoned out.** `deriveFloor` raises every
 * floor to the longest word of the refusal it would have to print, because at
 * two columns Ink hard-breaks `needs` and the refusal stops being a sentence —
 * a refusal nobody can read is not a refusal, and D14's argument collapses if
 * the refusal is itself the misleading output. So this view's floor lands at 9,
 * derived from the sentence rather than chosen, and `chrome.tsx` carries the
 * reasoning.
 *
 * What the rule buys here is still not a frequently useful refusal — view 4
 * declines only on panes narrower than nine columns. It is the guarantee that
 * this view degrades by the SAME rule as the other three and cannot quietly
 * acquire a hand-picked one.
 */
export const REPORT_FLOOR = deriveFloor("report", [["content", MIN_CONTENT]], GUTTER);

/**
 * The whole view 4 frame.
 *
 * `width={columns}` on the root and nowhere else — see `render.ts:32-40`: an
 * explicit width governs Ink's layout entirely, and a view that omits it
 * inherits the stream's width and silently ignores `model.columns`.
 */
export function RunReport({
  report,
  selection,
  now,
  columns,
}: {
  report: Region<readonly string[]>;
  selection: { readonly runId: string };
  now: number;
  columns: number;
}) {
  const p = usePalette();
  if (columns < REPORT_FLOOR.columns) {
    return <FloorRefusal floor={REPORT_FLOOR} have={columns} />;
  }
  /*
   * The heading NAMES THE SELECTION, so `report <run> — no data` is a sentence
   * this view can say. §6.2 calls view 4 "explicit, expensive, and worth it"
   * and `collectRunReport` is on no clock (§6.3) — it runs when the operator
   * asks — so the never-read frame is what they look at while it runs, and it
   * has to name the run they asked about.
   *
   * The LINE COUNT is the summary, and it is the only fact about the content
   * this file is allowed to state, because counting is not parsing.
   */
  const head = regionLine(
    `report ${selection.runId}`,
    report,
    now,
    (lines) => `${lines.length} line${lines.length === 1 ? "" : "s"}`,
  );
  return (
    <Box flexDirection="column" width={columns}>
      <Rule width={columns} />
      <RegionHeading text={head} failed={report.status === "failed"} />
      {/* ISC-478: not `ok` means the reason on the heading is the whole of what
          is known, and there is no body. */}
      {report.status !== "ok" ? null : report.value.length === 0 ? (
        /*
         * A report that rendered to nothing is `ok` and empty — `collectRunReport`
         * ran and produced no lines. Drawing nothing would be indistinguishable
         * from a frame that failed to paint, which is ISC-479's conflation
         * arriving in the one view an operator opens to find out what a run
         * cost.
         */
        <BodyLine dimColor={p.on}>{"  the report rendered no lines"}</BodyLine>
      ) : (
        report.value.map((line, i) => (
          /*
           * WRAPPED, never truncated. A report line is prose this view did not
           * compose and cannot re-clip (§6.2); truncating it would silently
           * delete whatever the line was about, and the lines most likely to be
           * long are the merge-precheck rows whose exact wording §6.2 pins.
           *
           * The index is in the key because `renderRunReport` emits repeated
           * blank lines as separators, and keying on the text alone would
           * collapse every one of them into a single node — closing up the
           * spacing that is part of the order §6.2 requires preserved.
           */
          <BodyLine key={`${i}:${line}`}>{`  ${line}`}</BodyLine>
        ))
      )}
    </Box>
  );
}
