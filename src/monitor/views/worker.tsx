/**
 * VIEW 2 — WORKER: one worker, in the depth view 1 has no room for
 * (SRD-FLEET-MONITOR §6.2 View 2, §6.4, §6.5, D8, ISC-503, ISC-504, ISC-505).
 *
 * ## What this file renders from, and what it must not reach for
 *
 * `model.detail` and `model.view` — the payload and the selection — and nothing
 * else. It does not touch `model.runs`, and the restraint is ISC-503's whole
 * content rather than tidiness: the fleet region is right there, it holds a
 * `WorkerRow` for this very worker, and reading it would let view 2 paint a row
 * from the SLOW clock's last enumeration while its own region says `no data`.
 * That is a frame in which two ages disagree and only one of them is on screen
 * — §6.4's failure with the marker still technically present.
 *
 * The selection is `ViewState`'s, so a worker view without a `(runId,
 * workerId)` pair is not representable (`model.ts:343-360`). "No view can
 * render without a selection" is therefore a fact about the type here, and the
 * only thing this file has to do is not invent one when `detail` is `never`.
 *
 * ## THE EVENT LINES ARE NOT RE-CLIPPED, AND THAT IS THE POINT
 *
 * `logs.ts`'s `sanitize`/`clip` (`:39-56`) has already run by the time these
 * reach the model (`model.ts:317-323`). **A second set of clipping rules is a
 * second spelling of one fact, which is the hazard ISC-345 names** — and the
 * two spellings would diverge in the direction that hurts, because the reader's
 * rules are about safety and a view's would be about width. So this file
 * measures nothing about a line's length and removes nothing from it.
 *
 * What it does instead is WRAP (`BodyLine`, `chrome.tsx`). Wrapping is a
 * presentation choice about a line the view was handed intact; clipping would
 * be a second decision about what the line is allowed to contain. The frame
 * grows taller and loses nothing, which is the correct trade for a view with no
 * columns to keep aligned.
 *
 * ## `clippedHead` IS VISIBLE, ALWAYS (ISC-504)
 *
 * §6.4 is "staleness is displayed, never hidden", and a truncated window is the
 * same class one level over: **a viewer whose history silently starts in the
 * middle is a viewer that lies about what happened.** The operator reading view
 * 2 is asking "which worker died and why", and the answer is very often above
 * the window. So `clippedHead` gets its own line, in the body where the events
 * are, rather than a mark on the heading that a reader scanning event text
 * would never look at.
 *
 * It is NOT rendered as a bullet row. The bullet marks the counters row, which
 * is a row about the worker; this is a statement about the WINDOW, and giving
 * it the same glyph would invite a reader to count it as an event.
 *
 * ## Three absences that must not collapse into one (ISC-479's shape)
 *
 * - `detail` is `never` — nothing has read this worker yet.
 * - `eventsPresent: false` — `events.jsonl` does not exist, which is NORMAL for
 *   a worker that has not started writing (`model.ts:331`).
 * - `eventsPresent: true` with no lines — the log exists and the window is
 *   empty.
 *
 * One string for all three would tell an operator that a worker which has never
 * been read is the same as one that has nothing to say.
 */

import { Box, Text } from "ink";

import type { DispatchVia, FenceView, Region, WorkerDetail } from "../model.ts";
import {
  BodyLine,
  Bullet,
  Cell,
  FloorRefusal,
  RegionHeading,
  Rule,
  deriveFloor,
  regionLine,
  usePalette,
} from "./chrome.tsx";

/**
 * Column widths for the counters row, fixed for the reason `fleet.tsx` gives:
 * a column sized to its longest current value moves when unrelated data
 * changes, and a monitor whose columns shift under the operator's eye is harder
 * to read than one that occasionally truncates.
 */
/** Widest output — `phase settling` plus room for a phase this build does not have. */
const PHASE_COL = 18;
/** Widest output — `turns not read`. */
const TURNS_COL = 16;
/** Widest output — `in 999999 out 999999`. */
const TOKENS_COL = 22;

/**
 * The floor, derived the same way view 1's is (ISC-505).
 *
 * **`phase` is the never-dropped cell, and the argument comes from the frozen
 * contract rather than from taste.** Of everything `state.json` gives view 2,
 * `WorkerDetail.phase` is the only field typed non-nullable
 * (`model.ts:324-341`): `turns`, `inputTokens`, `outputTokens`,
 * `credentialDegraded` and `exit` are every one of them `| null`. A floor built
 * on a cell that may hold nothing would refuse to draw a pane in order to
 * reserve room for `turns not read`, and the column that is guaranteed to carry
 * a fact is the one §6.5's "never dropped" can mean something about.
 *
 * The heading, the run line, the finding lines and the event body are not in
 * the sum: they are full-width lines that wrap or truncate on their own and do
 * not have to fit BESIDE anything. That is `fleet.tsx`'s rule applied
 * unchanged, and the consequence is a floor of 22 — lower than view 1's 32,
 * because view 2 has one column where view 1 has two.
 */
export const WORKER_FLOOR = deriveFloor("worker", [["phase", PHASE_COL]]);

/**
 * Which optional cells survive at a given width (§6.5, D14).
 *
 * Dropped in this order: **tokens first, then turns.** §6.5's own ladder is
 * about view 1 and names spend first, and `state.usage` IS the spend — so
 * dropping the token pair first is that ranking carried across rather than a
 * new one. `turns` outranks it for the reason `status.ts` prints it beside the
 * phase: a turn count is a coarse liveness signal where a token count is a
 * cost, and view 2 is opened when something has gone wrong rather than when
 * someone is reading a bill.
 *
 * A pure function of one number, exported, so the ORDER can be asserted over a
 * swept range rather than as a pair of remembered breakpoints.
 */
export interface WorkerLayoutPlan {
  readonly showTurns: boolean;
  readonly showTokens: boolean;
}

export function planWorkerColumns(columns: number): WorkerLayoutPlan {
  const withTurns = WORKER_FLOOR.columns + TURNS_COL;
  const withTokens = withTurns + TOKENS_COL;
  return { showTurns: columns >= withTurns, showTokens: columns >= withTokens };
}

/**
 * A count, or the fact that it was not read.
 *
 * `null` on these fields means `state.json` did not carry the key, which is not
 * the same as zero — a worker that has taken no turns and a worker whose usage
 * block is missing are different facts, and `0` for both is the conflation
 * `transcriptNote` (`status.ts:72-80`) already refuses one layer down.
 */
function countCell(label: string, n: number | null): string {
  return n === null ? `${label} not read` : `${label} ${n}`;
}

/** `state.usage`, as one cell, with the same not-read distinction. */
function tokensCell(input: number | null, output: number | null): string {
  if (input === null && output === null) return "tokens not read";
  const i = input === null ? "?" : String(input);
  const o = output === null ? "?" : String(output);
  return `in ${i} out ${o}`;
}

/**
 * `state.credential.degraded`, SURFACED RATHER THAN BURIED (`model.ts:337`).
 *
 * All three states get a line, including `false`. Printing nothing for a
 * healthy credential would be cheaper on screen and would make the absence of
 * the line mean two things at once — "not degraded" and "not read" — which is
 * the conflation this whole design keeps paying to avoid. One line always is
 * the version an operator can trust.
 */
function credentialLine(degraded: boolean | null): string {
  if (degraded === null) return "credential not read";
  return degraded ? "credential DEGRADED" : "credential ok";
}

/**
 * `state.exit`, when the worker has one.
 *
 * `null` means the worker has not exited (`model.ts:339`), which is a fact and
 * gets said. A missing `code` or `signal` inside a present exit record renders
 * as `none` rather than as an empty space, because `exit code  signal ` reads
 * as a rendering bug and `exit code none signal SIGKILL` reads as what it is.
 */
function exitLine(exit: WorkerDetail["exit"]): string {
  if (exit === null) return "no exit recorded";
  const code = exit.code === null ? "none" : String(exit.code);
  const signal = exit.signal === null ? "none" : exit.signal;
  return `exit code ${code} signal ${signal}`;
}

/**
 * The severity of the worker as a whole, for the counters bullet.
 *
 * A non-zero exit and a degraded credential are the two findings in this
 * payload that always mean something is wrong, so they take the alarm colour.
 * `exit code 0` is not a fault and does not.
 */
function detailSeverity(d: WorkerDetail, alarm: string | undefined, quiet: string | undefined) {
  const badExit = d.exit !== null && d.exit.code !== 0;
  return d.credentialDegraded === true || badExit ? alarm : quiet;
}

/** The counters row and the two finding lines — everything from `state.json`. */
function StateBlock({ detail, plan }: { detail: WorkerDetail; plan: WorkerLayoutPlan }) {
  const p = usePalette();
  const severity = detailSeverity(detail, p.alarm, p.quiet);
  const degradedColour = detail.credentialDegraded === true ? p.alarm : undefined;
  return (
    <Box flexDirection="column">
      <Box>
        <Bullet color={severity} />
        {/* Never dropped: the one field `WorkerDetail` guarantees is present. */}
        <Cell width={PHASE_COL} bold={p.on}>{`phase ${detail.phase}`}</Cell>
        {plan.showTurns ? (
          <Cell width={TURNS_COL} dimColor={p.on}>{countCell("turns", detail.turns)}</Cell>
        ) : null}
        {plan.showTokens ? (
          <Text wrap="truncate-end" dimColor={p.on}>
            {tokensCell(detail.inputTokens, detail.outputTokens)}
          </Text>
        ) : null}
      </Box>
      {/*
       * THE TWO FINDING LINES WRAP, and that is not the choice the cells above
       * make. It was found by LOOKING at a narrow frame rather than by
       * reasoning about one: at 26 columns a truncating exit line rendered
       * `exit code 137 signal SI…`, losing the signal name — and `SIGKILL`
       * versus `SIGTERM` is most of what the line is for.
       *
       * The rule, stated once and applied in three places in this file: **a
       * cell truncates because it is holding a column open for its neighbours,
       * and a finding has no neighbours.** Truncating one buys no alignment and
       * costs the fact.
       */}
      <BodyLine color={degradedColour} dimColor={p.on && detail.credentialDegraded === false}>
        {`  ${credentialLine(detail.credentialDegraded)}`}
      </BodyLine>
      <BodyLine dimColor={p.on && detail.exit === null}>{`  ${exitLine(detail.exit)}`}</BodyLine>
      {/*
       * THE REFUSAL SURFACE, and it wraps for the same reason the two lines
       * above do: it is a finding, not a cell holding a column open.
       *
       * This is §6.2's "a later action button has somewhere to be greyed out
       * and a reason to give", rendered in the view an operator opens BEFORE
       * acting on a worker. It is deliberately not on view 1's row: §6.5's
       * ladder is already shedding cells at narrow widths, and two more would
       * be dropped first and read never.
       *
       * `via: null` renders as "unknown" and NOT as `rpc`. The reader refuses
       * to guess (`read/worker.ts`'s `deriveVia`), and a view that filled the
       * gap with the permissive rung would undo that refusal one layer up —
       * greying in a button the command behind it would refuse.
       */}
      <BodyLine dimColor={p.on && detail.via === null}>{`  ${viaLine(detail.via)}`}</BodyLine>
      <BodyLine dimColor={p.on && detail.fence === null}>{`  ${fenceLine(detail.fence)}`}</BodyLine>
    </Box>
  );
}

/**
 * How a dispatch WOULD reach this worker — read, never acted on (D15).
 *
 * The wording says what would happen rather than naming the enum, because the
 * enum's three words mean nothing to someone who has not read `dispatch.ts`.
 */
function viaLine(via: DispatchVia | null): string {
  switch (via) {
    case "rpc":
      return "dispatch would go over the control socket";
    case "pane":
      return "dispatch would be typed into this worker's pane";
    case "staged":
      return "dispatch would be STAGED — a person owns this terminal";
    default:
      // Not "would use rpc". See the block above.
      return "dispatch route unknown — the launch record or presentation could not be read";
  }
}

/**
 * Whether an action would be refused `busy` or replayed (§6.2's third).
 *
 * `attemptCount` is carried even with no live epoch because it is what decides
 * REPLAY: a `(task, attempt)` pair already in the fence returns its original
 * epoch and runs nothing.
 */
function fenceLine(fence: FenceView | null): string {
  if (fence === null) return "no fence yet — this worker has taken no epoch";
  const attempts = `${fence.attemptCount} attempt${fence.attemptCount === 1 ? "" : "s"}`;
  if (fence.liveTaskId === null) return `fence idle — ${attempts} on record`;
  const abort = fence.abortRequested ? ", ABORT REQUESTED" : "";
  return `fence LIVE on ${fence.liveTaskId}${abort} — ${attempts} on record`;
}

/**
 * The event window.
 *
 * The clipped marker comes FIRST, above the oldest line it applies to, because
 * that is where the missing history would have been. Below the lines it would
 * read as a footer about the newest event, which is the opposite of what it
 * says.
 */
function EventBlock({ detail }: { detail: WorkerDetail }) {
  const p = usePalette();
  if (!detail.eventsPresent) {
    // `events.jsonl` does not exist yet, which is NORMAL (`model.ts:331`) and
    // must not be spelled the same way as an empty window.
    return <Text dimColor={p.on}>{"  no events yet"}</Text>;
  }
  return (
    <Box flexDirection="column">
      {detail.clippedHead ? (
        /*
         * ISC-504. Not a bullet row — the bullet marks rows about the worker,
         * and a reader scanning for events must not be able to count this as
         * one. Yellow rather than red: a clipped window needs a look and is not
         * itself a fault, the same rank `no-transcript` takes in `COLOUR`.
         */
        <Text wrap="wrap" color={p.warn} bold={p.on}>
          {"  events clipped — earlier lines not shown"}
        </Text>
      ) : null}
      {detail.eventLines.length === 0 ? (
        <Text dimColor={p.on}>{"  no events in window"}</Text>
      ) : (
        detail.eventLines.map((line, i) => (
          // The index is in the key because event lines repeat — two identical
          // `tool_result ok` lines are ordinary, and keying on the text alone
          // would drop the second.
          <BodyLine key={`${i}:${line}`}>{`  ${line}`}</BodyLine>
        ))
      )}
    </Box>
  );
}

/**
 * The whole view 2 frame.
 *
 * `width={model.columns}` is on the root and nowhere else, for the reason
 * `render.ts:32-40` measured: an explicit width governs Ink's layout entirely,
 * and a view that omits it inherits the stream's width and silently ignores
 * `model.columns` — which would make every degradation assertion in this design
 * a claim about the wrong thing.
 */
export function Worker({
  detail,
  selection,
  now,
  columns,
}: {
  detail: Region<WorkerDetail>;
  selection: { readonly runId: string; readonly workerId: string };
  now: number;
  columns: number;
}) {
  const p = usePalette();
  if (columns < WORKER_FLOOR.columns) {
    return <FloorRefusal floor={WORKER_FLOOR} have={columns} />;
  }
  /*
   * The HEADING NAMES THE SELECTION, not the payload.
   *
   * `worker eng-1 — no data` is a sentence view 2 must be able to say, and it
   * can only say it if the label comes from `model.view`. Taking the id out of
   * `detail.workerId` would mean a never-read region has no name to print, and
   * the honest renderings of that are a blank heading or a fabricated one.
   */
  const head = regionLine(
    `worker ${selection.workerId}`,
    detail,
    now,
    (d) => `${d.eventLines.length} event line${d.eventLines.length === 1 ? "" : "s"}`,
  );
  /*
   * THE PAYLOAD IS FOR SOMEONE ELSE — the one lie this view could tell that
   * §6.4's markers would not catch.
   *
   * Every marker in this design answers "how old is this?". None answers "is
   * this about the thing the heading names?". A selection that moved between
   * the read and the paint produces a fresh, correctly-aged frame describing
   * the previous worker under the new worker's name, and an operator reading
   * "which worker died and why" would act on it. It costs one comparison to say
   * so, and the alternative is trusting two independently-updated fields to
   * agree.
   */
  const mismatch =
    detail.status === "ok" &&
    (detail.value.workerId !== selection.workerId || detail.value.runId !== selection.runId)
      ? `${detail.value.workerId} in run ${detail.value.runId}`
      : null;
  const plan = planWorkerColumns(columns);
  return (
    <Box flexDirection="column" width={columns}>
      <Rule width={columns} />
      <RegionHeading text={head} failed={detail.status === "failed"} />
      {/*
       * The run line WRAPS while the heading above it truncates, and the split
       * is the same one the finding lines make. The heading is a SUMMARY — an
       * age and a count, whose loss at a narrow width costs a reader nothing
       * the next line does not give them. This is the SELECTION: §6.2's stable
       * `(run, worker)` pair, the thing every later action is addressed to and
       * the thing an operator copies. A half-truncated run id names no run.
       */}
      <BodyLine dimColor={p.on}>{`  run ${selection.runId}`}</BodyLine>
      {mismatch !== null ? (
        <Text wrap="wrap" color={p.alarm} bold={p.on}>
          {`  detail is for ${mismatch} — not the selected worker`}
        </Text>
      ) : null}
      {/* ISC-478: when the region is not `ok` the reason on the heading is the
          whole of what is known, and there is no body to draw. */}
      {detail.status === "ok" ? <StateBlock detail={detail.value} plan={plan} /> : null}
      {detail.status === "ok" ? <Rule width={columns} /> : null}
      {detail.status === "ok" ? <EventBlock detail={detail.value} /> : null}
    </Box>
  );
}
