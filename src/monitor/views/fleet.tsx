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
import { createContext, useContext } from "react";

import { regionAgeMs } from "../model.ts";
import type { FleetModel, GitStrip, Region, RunRow, WorkerRow } from "../model.ts";

/**
 * COLOUR IS OFF BY DEFAULT AND THAT IS NOT A STYLE PREFERENCE.
 *
 * Every byte-pinned assertion in `monitor-render.test.ts` compares plain text.
 * Ink emits SGR escapes inline when a `color` prop is set, so a coloured frame
 * turns `expect(row).toContain("wrote 11m ago")` into a comparison against
 * `\x1b[32mwrote 11m ago\x1b[39m` — every one of those tests would have to be
 * rewritten against escape codes, which is the "a component tree is not
 * pinnable" problem §6.6.1 refuted, arriving by a different route.
 *
 * So the palette is a CONTEXT with a plain default, and only `renderFleet`'s
 * caller turns it on. Tests get text; the pane gets colour; one component tree
 * produces both, so a styled frame cannot drift from the asserted one.
 */
export interface Palette {
  readonly on: boolean;
  readonly dim: string | undefined;
  readonly heading: string | undefined;
  readonly alarm: string | undefined;
  readonly warn: string | undefined;
  readonly live: string | undefined;
  readonly quiet: string | undefined;
}

export const PLAIN: Palette = {
  on: false,
  dim: undefined,
  heading: undefined,
  alarm: undefined,
  warn: undefined,
  live: undefined,
  quiet: undefined,
};

/**
 * The pane palette.
 *
 * Chosen against a DARK terminal, which is what the console runs in, and kept
 * to the eight ANSI names rather than 256-colour or truecolour so it inherits
 * whatever theme the operator has configured instead of fighting it.
 *
 * The assignment is by SEVERITY and not by category, which is the point:
 * `container-gone` is red because it is the one row that always means
 * something is wrong; `no-transcript` is yellow because it means "has never
 * spoken", which needs a look but is not itself a fault (Q1(b) — it must never
 * be read as "stuck"); `active` is green; everything a monitor cannot judge is
 * grey. An operator scanning the pane should be able to find the red without
 * reading a word.
 */
export const COLOUR: Palette = {
  on: true,
  dim: "gray",
  heading: "cyan",
  alarm: "red",
  warn: "yellow",
  live: "green",
  quiet: "white",
};

const PaletteContext = createContext<Palette>(PLAIN);
export const PaletteProvider = PaletteContext.Provider;
const usePalette = (): Palette => useContext(PaletteContext);

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
const INDENT = "    ";
const ID_COL = 8;
const ACTIVITY_COL = 20;
const PHASE_COL = 18;
const TASK_COL = 12;
/** Widest `containerCell` output — `container not checked`. */
const CONTAINER_COL = 21;

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
 */
export const FLOOR_COLUMNS = INDENT.length + ID_COL + ACTIVITY_COL;

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

const ROW_BASE = INDENT.length + ID_COL + ACTIVITY_COL;

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
 * How long ago, in the coarsest unit that still says something — seconds under a
 * minute, minutes under an hour, hours above.
 *
 * **This duplicates `ago` (`status.ts:39-45`) deliberately and the duplication is
 * argued rather than overlooked.** `ago` takes an ISO string; every age here is
 * already milliseconds from `regionAgeMs` (`model.ts:83`), so reusing it would
 * mean formatting a stamp back into a string to parse it again. More decisively,
 * `status.ts` is a `commander` command module under `src/cli/commands/`, and
 * ISC-468 requires the monitor's transitive import list to contain nothing that
 * dispatches — importing a formatter from there would drag the CLI, the registry
 * and the state writer into the viewer's closure to save nine lines.
 *
 * The two must agree on the BOUNDARIES, and they do: `< 60` seconds, `< 3600`
 * minutes, hours above. A monitor that said `90s` where `status` said `1m` would
 * make an operator comparing two panes doubt both.
 */
function coarseAge(ms: number): string {
  const s = Math.round(ms / 1_000);
  if (s < 60) return `${s}s`;
  if (s < 3_600) return `${Math.floor(s / 60)}m`;
  return `${Math.floor(s / 3_600)}h`;
}

/**
 * §6.4's three renderings, which must not collapse, in one place so they cannot
 * drift apart between regions.
 *
 * **The `never` case is decided by the ABSENCE OF AN AGE rather than by the
 * status tag**, which is not a stylistic choice: `model.ts:75-85` defines a
 * never-read region as one that "has no age, and rendering one as `0ms` would be
 * the same lie ISC-477 guards against from the other side". Reading the null
 * back out is that definition used rather than restated, so a future change to
 * `regionAgeMs` cannot leave this function confidently printing `as of 0s` for a
 * region nothing ever read.
 *
 * `summary` is applied only in the `ok` case, and that is what keeps ISC-479
 * satisfiable: `no data` and `none running` are produced by different branches
 * and can never be spelled by the same code path.
 */
function regionLine<T>(
  label: string,
  region: Region<T>,
  now: number,
  summary: (value: T) => string,
): string {
  const age = regionAgeMs(region, now);
  // `no data` is reached two ways and both state the same fact: this region has
  // no age. `regionAgeMs` returns `null` exactly for `never` (`model.ts:83-85`),
  // so today the two are the same test — but they are written as two because
  // they fail differently. Testing the RETURN keeps the line correct if `Region`
  // ever grows a fourth status whose age is unknown; testing the STATUS is what
  // narrows `region` for the branches below. Dropping either one costs a real
  // thing: without the first, a future status renders `as of NaN`; without the
  // second, this does not typecheck.
  if (age === null || region.status === "never") return `${label} — no data`;
  const asOf = `${label} — as of ${coarseAge(age)}`;
  // ISC-478: the reason stands IN PLACE of the content. There is no branch here
  // that can append it beside a retained value, because `Region.failed` carries
  // no value to retain (`model.ts:47-56`) — the type does the enforcing and this
  // function only has to not invent one.
  if (region.status === "failed") return `${asOf} — refresh failed: ${region.reason}`;
  return `${asOf} — ${summary(region.value)}`;
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

function containerCell(present: boolean | null): string {
  if (present === null) return "container not checked";
  return present ? "container up" : "no container";
}

/**
 * A fixed-width cell.
 *
 * `truncate-end` rather than `wrap`: a wrapped cell pushes every row below it
 * down and destroys the column alignment that is the entire reason an operator
 * can scan six workers in a glance. **The cost is real and is not hidden** — an
 * id longer than `ID_COL` loses characters, silently, which is the class of
 * thing §6.5 argues against. It is accepted here rather than solved because the
 * honest solution is the refusal ISC-485 specifies, and that criterion is open.
 */
function Cell({
  width,
  color,
  dimColor,
  bold,
  children,
}: {
  width: number;
  color?: string | undefined;
  dimColor?: boolean;
  bold?: boolean;
  children: string;
}) {
  return (
    <Box width={width}>
      <Text wrap="truncate-end" color={color} dimColor={dimColor} bold={bold}>
        {children}
      </Text>
    </Box>
  );
}

/** One worker: activity, phase, task, container — §6.2's row, minus what the model does not carry. */
function WorkerLine({ row, plan }: { row: WorkerRow; plan: LayoutPlan }) {
  const p = usePalette();
  const severity = activityColour(row.activity, p);
  /*
   * The BULLET is the only glyph added to the row, and it earns its column by
   * carrying the severity where the eye lands first. It is a plain `*` when
   * colour is off so that a piped frame and a painted one differ in escapes
   * and nothing else — a monitor whose text content changes with its styling
   * would make every assertion in this file a claim about the wrong frame.
   */
  return (
    <Box>
      <Text>{"  "}</Text>
      <Text color={severity}>{p.on ? "●" : "*"}</Text>
      <Text>{" "}</Text>
      {/* Never dropped: the id names the row, the activity cell IS the answer. */}
      <Cell width={ID_COL} bold={p.on}>{row.workerId}</Cell>
      <Cell width={ACTIVITY_COL} color={severity}>{activityCell(row)}</Cell>
      {plan.showPhase ? (
        <Cell width={PHASE_COL} dimColor={p.on}>{`phase ${row.phase}`}</Cell>
      ) : null}
      {plan.showTask ? (
        <Cell width={TASK_COL} dimColor={p.on}>
          {row.taskId === null ? "no task" : `task ${row.taskId}`}
        </Cell>
      ) : null}
      {plan.showContainer ? (
        <Text
          wrap="truncate-end"
          color={row.containerPresent === false ? p.alarm : undefined}
          dimColor={p.on && row.containerPresent !== false}
        >
          {containerCell(row.containerPresent)}
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
 * The git strip (§6.8, D12), with Q8's reversal applied: **status first, commits
 * behind `[c]`** — decided by the owner 2026-09-02 against the SRD's own first
 * proposal, because dirty paths change and a commit list on an idle branch does
 * not.
 *
 * The half that is not shown is rendered as a COUNT rather than dropped. D12
 * refuses to drop anything the incumbent showed, and a silently absent commit
 * list is the dead-field shape `contracts.ts:86-118` records — the reader cannot
 * tell an empty list from one behind a key they have never heard of. A count and
 * the key that reveals it costs one line and says both.
 *
 * `clean` for an empty status is the same distinction one level down: a strip
 * that rendered nothing would be indistinguishable from one that failed to read.
 */
function GitStripView({ region, now }: { region: Region<GitStrip>; now: number }) {
  const p = usePalette();
  const head = regionLine(
    "git",
    region,
    now,
    (g) => `${g.branchLine} — ${g.watchDir}`,
  );
  if (region.status !== "ok") {
    return <RegionHeading text={head} failed={region.status === "failed"} />;
  }
  const g = region.value;
  const shown = g.commitsExpanded ? g.commitLines : g.statusLines;
  const hidden = g.commitsExpanded
    ? `${g.statusLines.length} changed path${g.statusLines.length === 1 ? "" : "s"}`
    : `${g.commitLines.length} commit${g.commitLines.length === 1 ? "" : "s"}`;
  return (
    <Box flexDirection="column">
      <RegionHeading text={head} failed={false} />
      {shown.length === 0 ? (
        <Text color={p.live}>{`  ${g.commitsExpanded ? "no commits" : "clean"}`}</Text>
      ) : (
        shown.map((line) => (
          <Text key={line} wrap="truncate-end" color={g.commitsExpanded ? p.dim : p.warn}>
            {`  ${line}`}
          </Text>
        ))
      )}
      <Text dimColor={p.on}>{`  [c] ${hidden}`}</Text>
    </Box>
  );
}

/**
 * A full-width rule, drawn with the character §6.5's degradation never has to
 * think about: it is one line of the frame's own width and it truncates to
 * nothing interesting.
 *
 * ASCII `-` when colour is off, box-drawing `─` when it is on. **This is the one
 * place the plain and coloured frames differ in TEXT rather than only in
 * escapes**, and it is deliberate: a rule is pure decoration, so a piped frame
 * that a grep or a diff reads is better off with the character that survives
 * every encoding, while the pane gets the one that looks like a rule. Nothing
 * downstream parses it — unlike the severity bullet, which carries meaning and
 * is therefore present in both.
 */
function Rule({ width }: { width: number }) {
  const p = usePalette();
  return (
    <Text dimColor={p.on}>{(p.on ? "─" : "-").repeat(Math.max(0, width))}</Text>
  );
}

/** The floor refusal. Wraps rather than truncating — see {@link Fleet}. */
function RefusalText({ children }: { children: string }) {
  const p = usePalette();
  return (
    <Text color={p.alarm} bold={p.on}>
      {children}
    </Text>
  );
}

/**
 * A region's header line: bold, and RED when that region's own refresh failed.
 *
 * The failure colour is on the heading rather than only in the reason text
 * because §6.4's requirement is that a stale or broken region be findable at a
 * glance. An operator scanning three headings should not have to read them to
 * see which one stopped working.
 */
function RegionHeading({ text, failed }: { text: string; failed: boolean }) {
  const p = usePalette();
  return (
    <Text wrap="truncate-end" bold={p.on} color={failed ? p.alarm : p.heading}>
      {text}
    </Text>
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
    return (
      <RefusalText>{`pifleet monitor needs at least ${FLOOR_COLUMNS} columns; this pane has ${model.columns}.`}</RefusalText>
    );
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
      <RegionHeading
        text={regionLine("containers", model.containers, model.now, (names) =>
          names.length === 0 ? "none running" : `${names.length} seen`,
        )}
        failed={model.containers.status === "failed"}
      />
      <Rule width={model.columns} />
      <GitStripView region={model.git} now={model.now} />
    </Box>
  );
}
