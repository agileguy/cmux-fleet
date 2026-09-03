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

import { regionAgeMs } from "../model.ts";
import type { FleetModel, GitStrip, Region, RunRow, WorkerRow } from "../model.ts";

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
  // Narrowed on the DISCRIMINANT rather than on the age. `regionAgeMs` returns
  // `null` for exactly the `never` case and nothing else (`model.ts:83`), but
  // that is a fact about its body, not about its type, so a `null` age leaves
  // `never` in the union and the `ok` branch below does not compile. Testing
  // `status` says the same thing to a reader and lets the compiler check it —
  // which is what the three-state `Region` was introduced for.
  if (region.status === "never") return `${label} — no data`;
  const asOf = `${label} — as of ${coarseAge(regionAgeMs(region, now) ?? 0)}`;
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
function Cell({ width, children }: { width: number; children: string }) {
  return (
    <Box width={width}>
      <Text wrap="truncate-end">{children}</Text>
    </Box>
  );
}

/** One worker: activity, phase, task, container — §6.2's row, minus what the model does not carry. */
function WorkerLine({ row }: { row: WorkerRow }) {
  return (
    <Box>
      <Text>{INDENT}</Text>
      <Cell width={ID_COL}>{row.workerId}</Cell>
      <Cell width={ACTIVITY_COL}>{activityCell(row)}</Cell>
      <Cell width={PHASE_COL}>{`phase ${row.phase}`}</Cell>
      <Cell width={TASK_COL}>{row.taskId === null ? "no task" : `task ${row.taskId}`}</Cell>
      <Text wrap="truncate-end">{containerCell(row.containerPresent)}</Text>
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
function RunBlock({ run }: { run: RunRow }) {
  const n = run.workers.length;
  return (
    <Box flexDirection="column">
      <Text>{`  run ${run.runId} — ${n} worker${n === 1 ? "" : "s"}`}</Text>
      {run.workers.map((w) => (
        <WorkerLine key={w.workerId} row={w} />
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
  const head = regionLine(
    "git",
    region,
    now,
    (g) => `${g.branchLine} — ${g.watchDir}`,
  );
  if (region.status !== "ok") return <Text>{head}</Text>;
  const g = region.value;
  const shown = g.commitsExpanded ? g.commitLines : g.statusLines;
  const hidden = g.commitsExpanded
    ? `${g.statusLines.length} changed path${g.statusLines.length === 1 ? "" : "s"}`
    : `${g.commitLines.length} commit${g.commitLines.length === 1 ? "" : "s"}`;
  return (
    <Box flexDirection="column">
      <Text wrap="truncate-end">{head}</Text>
      {shown.length === 0 ? (
        <Text>{`  ${g.commitsExpanded ? "no commits" : "clean"}`}</Text>
      ) : (
        shown.map((line) => (
          <Text key={line} wrap="truncate-end">{`  ${line}`}</Text>
        ))
      )}
      <Text>{`  [c] ${hidden}`}</Text>
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
  return (
    <Box flexDirection="column" width={model.columns}>
      <Text wrap="truncate-end">
        {regionLine("fleet", model.runs, model.now, (runs) =>
          runs.length === 0 ? "no live runs" : `${runs.length} live run${runs.length === 1 ? "" : "s"}`,
        )}
      </Text>
      {model.runs.status === "ok"
        ? model.runs.value.map((run) => <RunBlock key={run.runId} run={run} />)
        : null}
      <Text wrap="truncate-end">
        {regionLine("containers", model.containers, model.now, (names) =>
          names.length === 0 ? "none running" : `${names.length} seen`,
        )}
      </Text>
      <GitStripView region={model.git} now={model.now} />
    </Box>
  );
}
