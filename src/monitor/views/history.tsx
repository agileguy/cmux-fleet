/**
 * VIEW 3 — RUN HISTORY: the runs root, newest first (SRD-FLEET-MONITOR §6.2
 * View 3, §6.5, D8, ISC-503, ISC-505).
 *
 * ## What this file renders from
 *
 * `model.history` and nothing else. It never reads `model.runs`, and the reason
 * is sharper here than anywhere else in the design: **the two regions overlap.**
 * A live run appears in both, on two different clocks, and a history view that
 * reached into the fleet region to "fill in" a run it recognised would show one
 * row aged by the slow walk beside another aged by the fast refresh, under a
 * single `as of`. That is §6.4's marker made meaningless by a convenience, and
 * ISC-503 exists to keep it from being written.
 *
 * ## Order is the model's, and the model's order has a specific origin
 *
 * `RunHistoryRow` is built from `runIdsAscending` and reversed — "the ONLY
 * correct enumeration" (Finding C, `model.ts:296-303`) — never sorted by mtime,
 * because a run directory's mtime moves when anything under it is written and
 * an mtime sort silently reorders history whenever an old run is touched. **So
 * this file does not sort.** A `.sort()` here would look like tidiness and
 * would quietly become a second enumeration order, which is the shape D10 and
 * ISC-345 both record.
 *
 * ## The ladder, and where its order comes from
 *
 * §6.5's descending list is written for view 1's row and has no clause for this
 * one, so the order is taken from §6.2's own listing of view 3's columns — "run
 * id, age, worker count, live/finished, task count, settled count" — and
 * dropped from the right. That is a derivation from the document rather than a
 * preference, and it is stated because the alternative (ranking them by what
 * looked useful) is unfalsifiable.
 *
 * The one adjustment: **`live/finished` is promoted out of the droppable set**
 * and joins the run id and the age as never-dropped. D8's entire content is
 * that live runs and history are different modes, and its stated cost is that
 * "a run that ended thirty seconds ago vanishes from the default view", making
 * "what just happened to the run I was watching" a keystroke. A history row
 * that has dropped the column answering *did it end* has not answered the
 * question the mode exists to answer.
 */

import { Box, Text } from "ink";

import type { Region, RunHistoryRow } from "../model.ts";
import {
  Bullet,
  Cell,
  FloorRefusal,
  RegionHeading,
  Rule,
  coarseAge,
  deriveFloor,
  regionLine,
  usePalette,
} from "./chrome.tsx";

/**
 * Column widths. Fixed, for `fleet.tsx`'s reason: a column sized to its longest
 * current value moves when an unrelated run appears.
 *
 * `RUN_SUFFIX_COL` and `RUN_ID_COL` are two widths for one column, which no
 * other view needs. View 1 can shorten its run id for free because the id is on
 * a block HEADER — a full-width line of its own — so narrowing it buys the
 * worker rows nothing and it shares a tier with the phase. Here the id is IN the
 * row, beside five other cells, so shortening it buys real width and it earns a
 * tier. That difference is why this file does not simply reuse `planColumns`.
 */
/** `3906`, the suffix `pifleet status` and the console panes already use. */
const RUN_SUFFIX_COL = 8;
/** `2026-09-02T14-43-27Z-3906` — 25 characters plus a gap. */
const RUN_ID_COL = 27;
/** `47s ago`, `11m ago`, `9h ago`. */
const AGE_COL = 10;
/** `finished`. */
const STATE_COL = 10;
/** `4 workers`. */
const WORKERS_COL = 12;
/** `11 tasks`. */
const TASKS_COL = 10;
/** `11 settled`. */
const SETTLED_COL = 12;

/**
 * The floor, derived the same way views 1 and 2 are (ISC-505).
 *
 * The run id is counted at its SUFFIX width, not its full width, and that is
 * the honest half of the derivation: at the floor the id renders as `3906`, so
 * the floor is what the row actually needs there. Counting the full id would
 * reserve twenty columns for a rendering the floor never produces and would
 * refuse panes on which the row is complete.
 */
export const HISTORY_FLOOR = deriveFloor("history", [
  ["run id (suffix)", RUN_SUFFIX_COL],
  ["age", AGE_COL],
  ["live/finished", STATE_COL],
]);

/**
 * Which optional columns survive at a given width (§6.5, D14).
 *
 * Acquired in §6.2's own listing order, which means dropped in reverse:
 * **settled first, then tasks, then workers, then the full run id.** The id is
 * the last of the optional rungs to go because §6.2 names it first and because
 * it is the SELECTION — §6.2's "stable `(run, worker)` pair" is what every
 * later action is addressed to, and an id an operator can read whole is the
 * thing they will copy.
 *
 * Exported so ISC-505's order can be asserted as a property over a swept range
 * rather than as four remembered breakpoints.
 */
export interface HistoryLayoutPlan {
  readonly runIdFull: boolean;
  readonly showWorkers: boolean;
  readonly showTasks: boolean;
  readonly showSettled: boolean;
}

export function planHistoryColumns(columns: number): HistoryLayoutPlan {
  const withFullId = HISTORY_FLOOR.columns + (RUN_ID_COL - RUN_SUFFIX_COL);
  const withWorkers = withFullId + WORKERS_COL;
  const withTasks = withWorkers + TASKS_COL;
  const withSettled = withTasks + SETTLED_COL;
  return {
    runIdFull: columns >= withFullId,
    showWorkers: columns >= withWorkers,
    showTasks: columns >= withTasks,
    showSettled: columns >= withSettled,
  };
}

/**
 * The SUFFIX is the last hyphen-delimited segment — `3906` from
 * `2026-09-02T14-43-27Z-3906`, which is the part `pifleet status` and the
 * console panes already use to name a run. Falling back to the whole id when
 * there is no hyphen keeps a hand-made run id from rendering as an empty cell.
 */
function runLabel(runId: string, full: boolean): string {
  return full ? runId : (runId.split("-").pop() ?? runId);
}

/**
 * A count with its unit named, singular and plural both correct.
 *
 * `1 tasks` is the kind of thing a reader stops on, and stopping on a rendering
 * detail in a monitor costs the glance the monitor exists to give.
 */
function countCell(n: number, unit: string): string {
  return `${n} ${unit}${n === 1 ? "" : "s"}`;
}

/** One run: id, age, state, and whatever counts fit (§6.2 View 3's own order). */
function HistoryLine({ row, plan }: { row: RunHistoryRow; plan: HistoryLayoutPlan }) {
  const p = usePalette();
  /*
   * The bullet carries LIVENESS, which is the severity this view has. A live
   * run in the history list is the row an operator is most likely to be looking
   * for — D8's cost is precisely that a run they were watching has moved here —
   * so it takes the colour the eye finds first.
   */
  const severity = row.live ? p.live : p.dim;
  return (
    <Box>
      <Bullet color={severity} />
      {/* Never dropped: the id names the row, the age orders it, and
          live/finished answers the question the mode exists for. */}
      <Cell width={plan.runIdFull ? RUN_ID_COL : RUN_SUFFIX_COL} bold={p.on}>
        {runLabel(row.runId, plan.runIdFull)}
      </Cell>
      <Cell width={AGE_COL}>{`${coarseAge(row.ageMs)} ago`}</Cell>
      <Cell width={STATE_COL} color={severity}>{row.live ? "live" : "finished"}</Cell>
      {plan.showWorkers ? (
        <Cell width={WORKERS_COL} dimColor={p.on}>{countCell(row.workerCount, "worker")}</Cell>
      ) : null}
      {plan.showTasks ? (
        <Cell width={TASKS_COL} dimColor={p.on}>{countCell(row.taskCount, "task")}</Cell>
      ) : null}
      {plan.showSettled ? (
        <Text wrap="truncate-end" dimColor={p.on}>{`${row.settledCount} settled`}</Text>
      ) : null}
    </Box>
  );
}

/**
 * The whole view 3 frame.
 *
 * `width={columns}` is on the root and nowhere else — see `Worker` and
 * `render.ts:32-40` for why a view that omits it silently ignores
 * `model.columns`.
 */
export function History({
  history,
  now,
  columns,
}: {
  history: Region<readonly RunHistoryRow[]>;
  now: number;
  columns: number;
}) {
  if (columns < HISTORY_FLOOR.columns) {
    return <FloorRefusal floor={HISTORY_FLOOR} have={columns} />;
  }
  const plan = planHistoryColumns(columns);
  /*
   * `no runs on disk` versus `no data` is ISC-479 in this view, and it is not
   * hypothetical here: `model.ts:209-215` says `history` is `never` until the
   * operator enters the mode, so the never-read frame is the one they see
   * FIRST — for however long the walk takes. Spelling it the same as an empty
   * runs root would tell them the fleet has no history while it is being read.
   */
  const head = regionLine("history", history, now, (rows) => {
    if (rows.length === 0) return "no runs on disk";
    const live = rows.filter((r) => r.live).length;
    return `${countCell(rows.length, "run")}, ${live} live`;
  });
  return (
    <Box flexDirection="column" width={columns}>
      <Rule width={columns} />
      <RegionHeading text={head} failed={history.status === "failed"} />
      {/* ISC-478 as control flow: a failed enumeration has no rows to show and
          the reason on the heading is the whole of what is known. */}
      {history.status === "ok"
        ? history.value.map((row) => <HistoryLine key={row.runId} row={row} plan={plan} />)
        : null}
    </Box>
  );
}
