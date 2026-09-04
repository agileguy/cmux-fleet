/**
 * The FLEET view: one block per run, one row per worker (SRD-FLEET-MONITOR
 * §6.2, §6.4, D5, D9).
 *
 * ## What this file is allowed to know
 *
 * A `FleetModel` and nothing else. No reader, no clock, no socket, no `Date.now`
 * — `model.now` is the only present moment in the file, for the same reason
 * `activity.ts` takes `now` as a parameter: a view that read the clock itself
 * could not be asked what it would have rendered a minute ago, and half the
 * assertions in `monitor-render.test.ts` are exactly that question.
 *
 * ## Every column names its source, and that is the design rather than a style
 *
 * `phase idle`, `container up`, `wrote 4s ago` — the prefix is doing work.
 * **D9's whole content is that `phase` sits BESIDE activity and never replaces
 * it**: for an attended worker `phase` is permanently `idle` and that is TRUE,
 * because no epoch is allocated (`voided.ts:136-140`, `model.ts:128-134`). A
 * column that printed a bare `idle` next to a bare `4s` would let a skimming
 * reader take the first for a verdict about the second, which is precisely the
 * misreading the incumbent pane produces today on four of six live workers
 * (SRD §1.2). Naming the source costs six characters a column and removes the
 * ambiguity entirely.
 *
 * For the same reason the activity cell carries **no verdict word**. §6.2 says
 * the ladder is "rendered as an age with its source named, never as a verdict",
 * so `active` and `quiet` reach the frame as `wrote 4s ago` and `wrote 11m ago`
 * and the operator does the ranking. `busy`/`idle` is the anti-shape: it is what
 * the incumbent prints, and it is a claim about a process this monitor cannot
 * see. **Note the consequence, because it is a real cost:** those two states are
 * distinguished in the frame by their AGE and by nothing else, so the fixtures
 * that pin them must differ in age or they pin nothing.
 *
 * ## Order is the model's, never this file's
 *
 * Runs and workers render in the order the model carries them. §6.2's third
 * requirement is a stable `(run, worker)` selection — "a design whose rows are
 * recomputed and re-sorted on every tick has no selection to attach an action
 * to" — and a sort here would be that design, arrived at by accident because
 * sorting a list before printing it looks like tidiness.
 *
 * ## What this file deliberately does NOT do
 *
 * §6.5's degradation ladder (spend -> container -> run-suffix -> phase, with the
 * activity age and staleness marker never dropped) is NOT implemented. The frame
 * is a function of `model.columns` — the root `Box` takes it, so the ladder has
 * somewhere to live — but at a narrow width Ink's flexbox drops whatever it
 * likes, which is exactly what ISC-484 says must not be left to it. That
 * criterion is open and this file is where it lands.
 */

import { Box, Text } from "ink";

import type { FleetModel, Region, RunRow, WorkerRow } from "../model.ts";
import { workerContainerName } from "../../run/paths.ts";
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
import type { Palette } from "./chrome.tsx";

/**
 * Column widths, fixed so that two frames of the same fleet are comparable
 * character by character.
 *
 * They are constants rather than measurements of the data because a column whose
 * width depends on the longest value in it MOVES when an unrelated worker
 * appears, and a monitor whose columns shift under the operator's eye every 30
 * seconds is harder to read than one that occasionally truncates. `ID_COL` is
 * sized for the ids this fleet actually issues (`eng-1`, `rev-1`, `w-0`); the
 * cost of the choice is stated at `Cell` below, where it is paid.
 */
const ID_COL = 8;
const ACTIVITY_COL = 20;
/**
 * Widest `phaseCell` output is `Starting` (8), plus the gap to the next column.
 *
 * It was 18, sized for the dropped `phase ` prefix. The width the prefix gave
 * back goes to the task id at the end of the row.
 */
const PHASE_COL = 10;
const TASK_COL = 12;
/**
 * Widest `containerCell` output is `Down` (4), plus the gap to the next column.
 *
 * It was 21, sized for `container not checked`. Shortening the values shortens
 * the column, and the width the row gives back goes to the task id at the end
 * of it — which is the column that was actually running out of room.
 */
const CONTAINER_COL = 6;

/**
 * The narrowest pane this monitor will draw on, DERIVED rather than probed.
 *
 * §6.5 says the floor comes from Q3, a measurement of real pane geometry. That
 * probe would set a number describing the operator's current terminal, and this
 * one describes the design: it is exactly the width the columns §6.5 forbids
 * dropping actually need — the indent, the worker id, and the activity cell.
 * Below it there is no layout left to degrade to, which is a stronger statement
 * than "narrower than the panes we happened to measure" and does not go stale
 * when someone resizes a window.
 *
 * Note what is NOT in the sum. The staleness markers (`fleet — as of 6s — …`)
 * are also never dropped, and they are not counted because they are full-width
 * lines that truncate rather than columns that must fit beside each other. A
 * floor that included them would refuse to draw panes on which the fleet table
 * is perfectly readable.
 *
 * It is expressed through `deriveFloor` (`chrome.tsx`) rather than as a bare
 * sum, because views 2-4 need the same treatment and four independently-picked
 * numbers cannot be checked against one another. Declaring WHICH cells may not
 * be dropped makes ISC-505 one property over four views instead of four
 * constants a reader has to take on trust.
 */
export const FLEET_FLOOR = deriveFloor("fleet", [
  ["worker id", ID_COL],
  ["activity", ACTIVITY_COL],
]);

/** The number itself, kept as its own export because every test names it. */
export const FLOOR_COLUMNS = FLEET_FLOOR.columns;

/**
 * Which optional columns survive at a given width (§6.5, D14, ISC-484).
 *
 * ## The order is the SRD's, with one documented deviation
 *
 * §6.5: "spend -> container uptime -> run-id suffix -> phase/epoch", with the
 * activity age and the staleness marker never dropped.
 *
 * - **spend** is not in `FleetModel` at all, so there is nothing to drop first.
 * - **task** is not in §6.5's list because the list predates the column. It is
 *   dropped EARLIEST, and the reason is observable rather than aesthetic: on
 *   this fleet every attended worker carries `task_id: null`, so it is the
 *   column that most often contains nothing.
 * - **run-id suffix and phase share a tier**, which is the deviation. §6.5
 *   ranks the suffix ahead of the phase and this preserves that precedence, but
 *   they cannot occupy separate tiers: the run id is on the BLOCK HEADER and
 *   the phase is on the worker ROW, so shortening the id buys the row no width
 *   whatsoever. Giving it a tier of its own would produce a band of widths in
 *   which the header fits and every row still overflows — a ladder rung that
 *   degrades nothing. Stated here rather than quietly reordered.
 *
 * A pure function of one number, exported, so ISC-484 can be asserted as an
 * ORDER — "container survives every width at which task does" — rather than as
 * a set of remembered breakpoints.
 */
export interface LayoutPlan {
  readonly showTask: boolean;
  readonly showContainer: boolean;
  readonly showPhase: boolean;
  readonly runIdFull: boolean;
}

const ROW_BASE = FLOOR_COLUMNS;

export function planColumns(columns: number): LayoutPlan {
  const withPhase = ROW_BASE + PHASE_COL;
  const withContainer = withPhase + CONTAINER_COL;
  const withTask = withContainer + TASK_COL;
  return {
    showTask: columns >= withTask,
    showContainer: columns >= withContainer,
    showPhase: columns >= withPhase,
    runIdFull: columns >= withPhase,
  };
}

/**
 * The §3.1 ladder as one cell of text.
 *
 * The switch is ordered to mirror `deriveActivity` (`activity.ts:207-216`) so
 * the two read the same way, and `container-gone` comes first for the reason
 * that function gives: it is a CONTRADICTION between the supervisor's `phase`
 * and `docker ps`, and a worker that wrote its transcript three seconds before
 * its container vanished must not render `wrote 3s ago`, which is a liveness
 * claim about a process that is not running.
 *
 * `active` and `quiet` share an arm on purpose — see the file header. Their
 * split is the growth window's business (`activity.ts:123`) and re-deciding it
 * here would be the two-readers-of-one-fact shape ISC-231 and ISC-345 record.
 * Their shared arm still has two outcomes, and the second is a fact the first
 * cannot express: `no writes yet` is MEASURED-AND-NEVER-GREW, which
 * `transcriptNote` (`status.ts:76`) already keeps apart from an age and which a
 * bare `wrote null ago` would destroy.
 *
 * No `default`. The union is exhausted, so adding a sixth `Activity` fails the
 * typecheck here instead of rendering as a blank cell — and a blank cell is the
 * failure ISC-482 names: it reads as "nothing to report".
 */
function activityCell(row: WorkerRow): string {
  switch (row.activity) {
    case "container-gone":
      return "container gone";
    case "rpc":
      return "not measured (rpc)";
    case "no-transcript":
      return "no transcript";
    case "active":
    case "quiet":
      return row.transcriptAgeMs === null
        ? "no writes yet"
        : `wrote ${coarseAge(row.transcriptAgeMs)} ago`;
  }
}

/**
 * Three states, three strings, and the third is the one that matters.
 *
 * `null` means the slow clock has never completed (`activity.ts:99-107`) —
 * `Region`'s `never` arriving here as an absence of fact rather than as a
 * negative. **Collapsing it into `no container` would put the most actionable
 * finding this monitor has on every worker at startup**, which would teach the
 * operator to ignore it by the second morning.
 */
/** Severity colour for one ladder state. See {@link COLOUR}. */
function activityColour(activity: WorkerRow["activity"], p: Palette): string | undefined {
  switch (activity) {
    case "container-gone":
      return p.alarm;
    case "no-transcript":
      return p.warn;
    case "active":
      return p.live;
    case "quiet":
      return p.quiet;
    case "rpc":
      return p.dim;
  }
}

/**
 * The row's severity: `busy` is live, everything else is dim — and the
 * transcript-write ladder does not get a vote.
 *
 * WHY NOT THE LADDER. `activity` measures TRANSCRIPT WRITES, which is a proxy
 * for "is anything happening" that is wrong in both directions, and both were
 * measured on the same worker within two minutes on 2026-09-04:
 *
 *   tst-1  wrote 1m ago   phase busy   -> `quiet`  -> white, same as four idle
 *                                          workers, while running a 1120-test
 *                                          suite. The one row worth finding was
 *                                          styled to disappear.
 *   tst-1  wrote 19s ago  phase idle   -> `active` -> green, having finished.
 *                                          Nothing was happening.
 *
 * A long tool call writes nothing while doing the most work of the run, and a
 * worker's last write lands just as it stops. `phase` is what `state.json`
 * actually says about whether an epoch is being held, and it is what the
 * colour should answer with, because the colour is what the eye reaches first.
 *
 * The activity CELL still reports the ladder in text, which is the right place
 * for a proxy: readable when wanted, not shouting when not.
 *
 * WHAT BUSY DOES NOT OUTRANK, AND WHAT IDLE DOES NOT HIDE. `container-gone`
 * and `no-transcript` are findings rather than states, and neither phase makes
 * them less true — a worker whose container has vanished while `state.json`
 * still says busy is exactly the row that must not be painted green, and one
 * that never produced a transcript is worth flagging whether or not it happens
 * to be holding an epoch. Those two keep their own severity.
 */
export function rowColour(row: WorkerRow, p: Palette): string | undefined {
  if (row.activity === "container-gone" || row.activity === "no-transcript") {
    return activityColour(row.activity, p);
  }
  return row.phase === "busy" ? p.live : p.dim;
}

/**
 * The container column: `Up`, `Down`, or a dash.
 *
 * It read `container up` / `no container` / `container not checked` in a
 * 21-wide column. The word `container` was the heading of a column whose every
 * value repeated it, so nineteen of those characters said nothing the position
 * did not already say — and the state, which is the whole point, was the last
 * word rather than the first.
 *
 * `Up` and `Down` are bold green and bold red at the call site, which is where
 * the eye should be able to stop.
 *
 * **The dash is the third state and it is not `Down`.** `null` means the slow
 * clock has never completed (`activity.ts:99-107`) — an absence of fact, not a
 * negative. Every worker is `null` for the first half-cycle after `up`, so
 * rendering it as a bold red `Down` would put the monitor's most actionable
 * finding on every row at startup, and teach the operator to ignore it by the
 * second morning. It is dim and wordless because there is nothing to report
 * yet.
 */
/**
 * The phase column: `Idle`, `Busy`, and whatever else `state.json` says.
 *
 * It read `phase idle` in an 18-wide column. As with `container`, the word
 * `phase` was a heading repeated on every value, and the value was the half a
 * reader actually wanted.
 *
 * The string is CAPITALISED rather than mapped, so a phase this view has never
 * heard of (`settling`, `stalled`, `dead`, or one added later) still renders
 * as itself. A `switch` with a default would have to choose between inventing
 * a label and rendering nothing; neither is better than the word the
 * supervisor actually wrote.
 */
export function phaseCell(phase: string): string {
  return phase === "" ? "—" : phase[0]!.toUpperCase() + phase.slice(1);
}

export function containerCell(present: boolean | null): string {
  if (present === null) return "—";
  return present ? "Up" : "Down";
}

/** Colour for the container cell. Bold green up, bold red down, dim unknown. */
export function containerColour(present: boolean | null, p: Palette): string | undefined {
  if (present === null) return p.dim;
  return present ? p.live : p.alarm;
}

/**
 * Containers `docker ps` reported that no worker row accounts for.
 *
 * The count was the whole region: `containers — as of 3s — 9 seen`. Six of
 * those nine are the workers listed directly above it, each with its own `Up`
 * cell — so the number's only real content was the OTHER three, and it stated
 * them by arithmetic the reader had to do.
 *
 * The other three are the egress relays. They are the fleet's network, every
 * worker's outbound traffic goes through one, and a worker whose relay has
 * died is a worker that fails at its first `curl` with nothing on this screen
 * to explain it. They were the least visible containers in the design and are
 * the ones an operator cannot diagnose around.
 *
 * DERIVED, never a second list. `workerContainerName` is the single definition
 * of a worker container's name and the same function `up` names them with, so
 * a rename cannot leave this filter matching the old shape and quietly
 * promoting every worker into this section.
 */
export function unclaimedContainers(model: FleetModel): readonly string[] {
  if (model.containers.status !== "ok") return [];
  /*
   * A FAILED runs region lists NOTHING, and the guard belongs here rather than
   * at the call site.
   *
   * With no worker rows every container is unclaimed, so the arithmetic answer
   * is "all of them" under a heading that says `not a worker` — a lie told by
   * a region already reporting a failure one line up. Keeping this in the
   * component would make it a property of one caller instead of a property of
   * the answer, and the next caller would get the lie.
   */
  if (model.runs.status !== "ok") return [];
  const claimed = new Set<string>();
  for (const run of model.runs.value) {
    for (const w of run.workers) claimed.add(workerContainerName(run.runId, w.workerId));
  }
  return model.containers.value.filter((n) => !claimed.has(n));
}

/**
 * The containers region: the count, then the ones no worker row explains.
 *
 * A failed `runs` region yields an empty list — see `unclaimedContainers`,
 * which owns that rule — so the heading's own failure marker is left to say
 * what happened.
 */
function ContainersRegion({ model }: { model: FleetModel }) {
  const p = usePalette();
  const others = unclaimedContainers(model);
  return (
    <Box flexDirection="column">
      <RegionHeading
        text={regionLine("containers", model.containers, model.now, (names) =>
          names.length === 0
            ? "none running"
            : `${names.length} seen, ${others.length} not a worker`,
        )}
        failed={model.containers.status === "failed"}
      />
      {others.map((name) => (
        /*
         * STATE FIRST, NAME LAST AND UNBOUNDED — the same shape the task id
         * needed, for the same reason.
         *
         * These rows do not align with the worker rows above and should not:
         * they have no activity, no phase and no task, and padding them into
         * those columns would invite the reader to compare cells that mean
         * nothing here. What they have is a name and a state.
         *
         * The name goes last because these names share long prefixes —
         * `pifleet-egress-relay-pifleet-egress`, `…-ollama-cloud`, `…-omlx` —
         * so a fixed column truncates all three to the identical string
         * `pifleet-egress-relay-piflee…`. Three rows that cannot be told apart
         * are worse than the count they replaced.
         */
        <Box key={name}>
          {/*
           * A PLAIN INDENT, not a `Bullet`.
           *
           * The bullet is the worker-row marker: `monitor-render.test.ts`
           * counts worker rows by it precisely because it is "on every worker
           * row and on nothing else", which is how that test proves a failed
           * runs region renders no rows rather than proving the rows never
           * existed. Putting one here would have quietly made that count 8
           * instead of 6 and cost the test its subject.
           *
           * Nothing is lost: the bullet carries severity, and severity here is
           * already the bold green `Up` beside it.
           */}
          <Text>{"    "}</Text>
          <Cell width={CONTAINER_COL} color={p.live} bold={p.on}>Up</Cell>
          <Text wrap="truncate-end" bold={p.on}>{name}</Text>
        </Box>
      ))}
    </Box>
  );
}

/** One worker: activity, phase, task, container — §6.2's row, minus what the model does not carry. */
function WorkerLine({ row, plan }: { row: WorkerRow; plan: LayoutPlan }) {
  const p = usePalette();
  const severity = rowColour(row, p);
  /*
   * The BULLET is the only glyph added to the row, and it earns its column by
   * carrying the severity where the eye lands first. It is a plain `*` when
   * colour is off so that a piped frame and a painted one differ in escapes
   * and nothing else — a monitor whose text content changes with its styling
   * would make every assertion in this file a claim about the wrong frame.
   */
  return (
    <Box>
      <Bullet color={severity} />
      {/* Never dropped: the id names the row, the activity cell IS the answer. */}
      <Cell width={ID_COL} bold={p.on}>{row.workerId}</Cell>
      <Cell width={ACTIVITY_COL} color={severity}>{activityCell(row)}</Cell>
      {plan.showPhase ? (
        <Cell
          width={PHASE_COL}
          color={row.phase === "busy" ? p.busy : undefined}
          bold={p.on && row.phase === "busy"}
          dimColor={p.on && row.phase !== "busy"}
        >
          {phaseCell(row.phase)}
        </Cell>
      ) : null}
      {plan.showContainer ? (
        <Cell
          width={CONTAINER_COL}
          color={containerColour(row.containerPresent, p)}
          bold={p.on && row.containerPresent !== null}
          dimColor={p.on && row.containerPresent === null}
        >
          {containerCell(row.containerPresent)}
        </Cell>
      ) : null}
      {/*
       * TASK IS LAST, AND THAT IS WHAT MAKES IT WHOLE.
       *
       * It used to sit between phase and container in a 12-wide `Cell`, which
       * truncated every real id this fleet issues — `task T-rall…` for
       * `T-rally-accept`. A task id is the one value on the row an operator
       * has to read EXACTLY, because it is what they type into `wait`,
       * `artifacts` and `unstage`; a truncated one is not a shorter answer,
       * it is no answer.
       *
       * Last is the only position where widening it costs nothing. Every
       * earlier column is fixed so that two frames of the same fleet line up
       * character by character, and a variable-width cell in the middle would
       * move everything to its right as tasks came and went. At the end it
       * takes whatever the pane has left and truncates only when even that
       * runs out.
       *
       * Position is not precedence: task is rendered last and still DROPPED
       * first (`planColumns`), because on this fleet it is the column most
       * often empty. The two orders answer different questions.
       *
       * Bold white when a task is actually held, dim otherwise. The row's
       * bullet already says whether work is happening; this says what the work
       * IS, and `no task` is the one value nobody needs to read quickly.
       */}
      {plan.showTask ? (
        <Text
          wrap="truncate-end"
          bold={p.on && row.taskId !== null}
          color={row.taskId === null ? undefined : p.quiet}
          dimColor={p.on && row.taskId === null}
        >
          {row.taskId === null ? "no task" : `task ${row.taskId}`}
        </Text>
      ) : null}
    </Box>
  );
}

/**
 * One run and its workers.
 *
 * The run id is printed WHOLE rather than as the suffix §6.2's flat row uses,
 * because blocking by run means it appears once instead of on every row, and a
 * suffix is only worth the ambiguity when it is paid for six times.
 */
function RunBlock({ run, plan }: { run: RunRow; plan: LayoutPlan }) {
  const p = usePalette();
  const n = run.workers.length;
  /*
   * The SUFFIX is the last hyphen-delimited segment — `e533` from
   * `2026-09-02T14-43-01Z-e533`, which is the part `pifleet status` and the
   * console panes already use to name a run. Falling back to the whole id when
   * there is no hyphen keeps a hand-made run id from rendering as an empty
   * heading.
   */
  const label = plan.runIdFull ? run.runId : (run.runId.split("-").pop() ?? run.runId);
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end" color={p.heading}>
        {`  run ${label} — ${n} worker${n === 1 ? "" : "s"}`}
      </Text>
      {run.workers.map((w) => (
        <WorkerLine key={w.workerId} row={w} plan={plan} />
      ))}
    </Box>
  );
}


/**
 * The whole frame.
 *
 * `width={model.columns}` is on the root and nowhere else: it is the single
 * place the terminal's geometry enters the view, which is what will make ISC-484
 * implementable as a change to this component rather than as a change to every
 * cell.
 *
 * The run blocks render only when `runs` is `ok`. That is ISC-478 as control
 * flow — a failed enumeration has no runs to show and the reason on the header
 * line is the whole of what is known.
 */
export function Fleet({ model }: { model: FleetModel }) {
  /*
   * ISC-485: REFUSE, rather than draw something misleading.
   *
   * Below the floor there is no rung left — the id and the activity cell are
   * what §6.5 forbids dropping, and they are the whole of `FLOOR_COLUMNS`. The
   * alternative is what this component did before the ladder existed: hand the
   * row to Ink's flexbox and let it drop whichever columns it liked, silently,
   * which is exactly ISC-484's complaint.
   *
   * The sentence NAMES THE NUMBERS, both of them, on `RunDirMountError`'s
   * pattern (`paths.ts:755-791`): a refusal an operator can act on beats one
   * they have to investigate. "Too narrow" would send them to the source.
   */
  if (model.columns < FLOOR_COLUMNS) {
    return <FloorRefusal floor={FLEET_FLOOR} have={model.columns} />;
  }
  const plan = planColumns(model.columns);
  return (
    <Box flexDirection="column" width={model.columns}>
      <Rule width={model.columns} />
      <RegionHeading
        text={regionLine("fleet", model.runs, model.now, (runs) =>
          runs.length === 0 ? "no live runs" : `${runs.length} live run${runs.length === 1 ? "" : "s"}`,
        )}
        failed={model.runs.status === "failed"}
      />
      {model.runs.status === "ok"
        ? model.runs.value.map((run) => <RunBlock key={run.runId} run={run} plan={plan} />)
        : null}
      <Rule width={model.columns} />
      <ContainersRegion model={model} />
    </Box>
  );
}
