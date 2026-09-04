/**
 * One worker's row, read from the run tree (SRD-FLEET-MONITOR §2.3, §6.3, D6).
 *
 * ## Every document here is parsed by the reader that already owns it
 *
 * `readWorkerState` (`run/state.ts:55`), `readPresentation` (`run/state.ts:668`)
 * and `readAttended` (`attended/mode.ts:344`) are used verbatim. A local
 * `JSON.parse` in this file would be shorter and it would be wrong twice over:
 *
 * - It discards `readValidated`'s **torn-read retry** (`run/state.ts:815-830`).
 *   These files are written tmp + fsync + rename, so a short buffer ending
 *   mid-token means the rename landed between the stat and the read — a real
 *   condition that "appeared only under CI's timing, never in eight local
 *   runs". `state.json` is rewritten every 250 ms while a worker is live
 *   (`supervisor/index.ts:94`) and this module reads it on the 500 ms clock,
 *   so the monitor polls the same file twice per write. It is the single
 *   likeliest place in the fleet to observe a torn read, and a local parser
 *   would render one as though the file said something.
 *
 * - It discards `StateReadError` (`run/state.ts:786-804`), which carries the
 *   path, the zod issue paths, and the bytes. §6.4 requires that message on
 *   screen in place of the row's content, so a reader that throws a bare
 *   `SyntaxError` has already lost the sentence the display layer needs.
 *
 * That is ISC-472, and it is the same rule `run/paths.ts:1-18` states for
 * paths, applied to parsers: one definition, because two will diverge and
 * neither half will know.
 *
 * ## What this module does NOT derive
 *
 * **`activity` is absent from the row on purpose.** `model.ts:120-123` puts
 * the five-state ladder in `src/monitor/activity.ts` and says why — one
 * definition the fixtures can pin. So the type here is
 * {@link PartialWorkerRow}, spelled `Omit<WorkerRow, "activity">` rather than
 * re-declared, which makes "this is a `WorkerRow` minus one derived field" a
 * compile-time fact instead of a comment that rots. It is a MISSING FIELD, not
 * a placeholder value: a placeholder would be a sixth activity state wearing
 * one of the five names, which is exactly the conflation `model.ts:99-104`
 * refuses for `wedged`.
 *
 * **Transcript growth is not re-measured.** `transcriptAgeMs` comes from
 * `state.transcript_activity.last_growth_at`, which the supervisor's own
 * poll already computed (`contracts.ts:157-163`). Statting `session_path`
 * here would make the monitor a SECOND reader of one fact — ISC-231 and
 * ISC-345's shape, and D6's stated mitigation is written against exactly
 * those. It also keeps this module clean under ISC-471 for free:
 * `session_path` is recorded verbatim from `get_state` and is not a
 * `workerPaths` member, so a reader that opened it would be opening a path no
 * path module computed.
 *
 * **The container is joined, never spelled.** `workerContainerName`
 * (`run/paths.ts:484`) is called. Its docblock records three of four call
 * sites once using their own template literal, "one rename away from a `down`
 * that cleans up a container nobody launched"; §2.6 says a monitor becomes the
 * fifth caller and must use the function.
 *
 * **The refusal surface is MIRRORED, never re-derived.** `via` is what
 * `dispatch` would do, and `dispatch` is the only authority on that
 * (`cli/commands/dispatch.ts`'s `planDispatch` at `:291` and `sendViaPane`'s
 * fork at `:533-:568`). {@link deriveVia} restates that decision arm for arm
 * with the code cited beside each; it does not improve on it. A monitor whose
 * greyed-out button disagreed with the command it grey-outs would be worse
 * than one with no button, because the disagreement is invisible until someone
 * presses the key — which is ISC-345's shape on the one surface D15 exists to
 * prepare.
 */

import { monotonicMs } from "../../util/clock.ts";
import { failed, never, ok, type DispatchVia, type FenceView, type Region, type WorkerRow } from "../model.ts";
import { workerContainerName, workerPaths, type RunPaths, type WorkerPaths } from "../../run/paths.ts";
import { readFence, readPresentation, readWorkerLaunch, readWorkerState } from "../../run/state.ts";
import { launchPaneMode } from "../../container/interrupt.ts";
import { readAttended } from "../../attended/mode.ts";
import type { AttendedRecord, Presentation, WorkerLaunch, WorkerState } from "../../contracts.ts";

/**
 * A `WorkerRow` with the one DERIVED field withheld — see the header.
 *
 * `Omit` rather than a hand-written interface: if `WorkerRow` gains a field,
 * this type gains it too and the compiler names every site that must fill it.
 * A parallel declaration would silently keep producing the old shape.
 */
export type PartialWorkerRow = Omit<WorkerRow, "activity">;

/**
 * The validated documents `src/monitor/activity.ts` needs, carried out of this
 * reader rather than re-read by it.
 *
 * `WorkerRow` has no field for `adopted_terminal`, for the presence of
 * `attended.json`, or for `session_present` — yet `model.ts:92-97` names all
 * three as the evidence that distinguishes an attended worker who has never
 * spoken from an `rpc` worker, which is Finding A and the whole reason the
 * five-state ladder exists. So the ladder's inputs have to reach it somehow,
 * and there are only two shapes: this bundle, or `activity.ts` opening the
 * same three files a second time. The second is ISC-231's defect by
 * construction, so it is this bundle.
 *
 * CHECKED against `monitor/activity.ts`'s `WorkerFacts` as it stands, rather
 * than designed against a guess about it: its six fields map onto this bundle
 * with no further reads — `adoptedTerminal` from `presentation.adopted_terminal`,
 * `attendedMode` from `attended.mode`, `sessionPresent`, `transcriptActivity`
 * and `phase` from `state`, and `containerPresent` from the row. Note it wants
 * the record's MODE and not its presence: `leaveTui` REWRITES the record to
 * `"viewer"` on hand-back rather than deleting it (`attended/mode.ts:471`), so
 * a boolean derived here would call every steered worker attended forever.
 * That is why the whole record travels.
 */
export interface WorkerEvidence {
  readonly state: WorkerState;
  /** Immutable after `up` (§2.7) and cacheable; `null` when never written. */
  readonly presentation: Presentation | null;
  /** Written once and never removed (`report/collect.ts:266-268`). */
  readonly attended: AttendedRecord | null;
  /**
   * `launch.json` — what `up` ACTUALLY RAN, and the only place `pane_mode`
   * lives (`contracts.ts:693`).
   *
   * **This is a NEW read, and §6.2's second bullet asks for the wrong file.**
   * The SRD says "a worker's `presentation.adopted_terminal` and `pane_mode`
   * decide whether `dispatch` would refuse it", which reads as though both were
   * fields of `presentation.json`. `pane_mode` is not in `presentation.json`
   * and is not in `state.json`; it is a field of the launch record, and
   * `dispatch` reaches it through `launchPaneMode` over the recorded argv
   * rather than trusting the field alone. So `via` costs one more file than the
   * SRD's sentence implies, and the alternative to paying for it is a `via`
   * column derived from a file that cannot answer the question.
   *
   * The cost is affordable for a reason the other satellites already establish:
   * the record is IMMUTABLE after `up` (`contracts.ts`: "`up` is the only
   * process that resolves `pane_mode`, and this is its output"), so it is read
   * on the slow walk and carried forward by the fast refresh exactly as
   * `presentation.json` and `attended.json` are. MEASURED at 0.119 ms per
   * worker on the operator's own runs root — see `MEASURED_MS` in `clocks.ts`,
   * where the number is declared rather than assumed.
   *
   * `null` means the record is ABSENT, which is a positive fact rather than an
   * absence of one: it is the `PIFLEET_PI_COMMAND` double, and `planDispatch`
   * (`dispatch.ts:291`) and `planInterrupt` (`interrupt.ts:234`) both answer
   * `rpc` for it, in as many words. See {@link launchUnreadable} for the case
   * that is genuinely "I could not tell".
   */
  readonly launch: WorkerLaunch | null;
  /**
   * `launch.json` exists and could not be read — schema-invalid, torn, or
   * unreadable.
   *
   * **A separate flag rather than folding into `launch === null`, and the two
   * must not merge.** Absence is `rpc` by `planDispatch`'s explicit decision;
   * a failed read is no answer at all and must produce `via: null`. Collapsing
   * them would make a damaged launch record render as the most freely
   * dispatchable worker in the fleet, which is precisely the reassuring lie
   * `model.ts:271-275` refuses for `presentation.json`, arriving from the
   * other file.
   */
  readonly launchUnreadable: boolean;
  /**
   * Satellites that could not be read, named rather than swallowed.
   *
   * A damaged `presentation.json` or `attended.json` must NOT take the row
   * down: `phase`, `task_id` and the transcript age all come from `state.json`
   * and are still true. What it costs is `activity` precision, and the honest
   * report of that is a note the display layer can show — the shape
   * `CollectedReport.notes` (`report/collect.ts:68-115`) already uses, for the
   * reason its header gives: "`report` is what an operator runs when things
   * went WRONG". So does a monitor.
   */
  readonly notes: readonly string[];
}

/** One worker's contribution to a frame. */
export interface WorkerRead {
  readonly row: PartialWorkerRow;
  readonly evidence: WorkerEvidence;
}

export interface WorkerReadOptions {
  /**
   * Container names from the last SLOW tick (`docker ps`), or `null` when that
   * region is not `ok`.
   *
   * `null` propagates to `containerPresent: null` — "not looked at" — and must
   * not collapse to `false`. `false` means `docker ps` ran and this container
   * was absent, which `model.ts:114` turns into `container-gone`: the single
   * most actionable row in the design. Deriving it from a Docker read that
   * never happened would manufacture that finding on no evidence.
   */
  readonly containers?: ReadonlySet<string> | null;
  /** MONOTONIC, for `readAt`. Defaults to `monotonicMs`. */
  readonly now?: () => number;
  /**
   * WALL CLOCK, for `transcriptAgeMs` only. Defaults to `Date.now`.
   *
   * Separate from {@link now} and deliberately not defaulted from it: the two
   * measure different things against different origins, and a test that sets
   * one and forgets the other should get an obviously wrong number rather than
   * a quietly wrong one.
   */
  readonly wallNow?: () => number;
}

/**
 * Read one worker.
 *
 * ## Why a missing `state.json` is `never` and not `ok`
 *
 * `model.ts:57-64` keeps "I could not look" apart from "I looked and there was
 * nothing", and for most readers the second is representable as an empty
 * value. `PartialWorkerRow` has no empty inhabitant: `phase` is
 * `PhaseSchema`'s six-member enum (`contracts.ts:68`) and `model.ts:130-134`
 * requires it "carried verbatim and NOT reinterpreted". Synthesising a
 * seventh phase to mean "no state file" would put a monitor-invented value
 * into a field documented as the supervisor's own word — ISC-216's shape, a
 * code that conflates two states.
 *
 * So a worker directory with no `state.json` yields `never`, which the display
 * layer renders `no data`, distinct from a `failed` row's reason. That is
 * truthful: a materialised worker directory whose supervisor never wrote state
 * is a worker nothing has ever observed.
 *
 * ## Why a damaged `state.json` fails only this region (ISC-475)
 *
 * `readWorkerState` throws, this function catches, and the throw is converted
 * to a `failed` region carrying `StateReadError`'s own message. Nothing
 * propagates to a sibling worker, because the catch is INSIDE the per-worker
 * unit rather than around the loop — a `try` around the whole table is the
 * version a reasonable person writes first, and it turns one truncated file
 * into an empty fleet.
 */
export async function readWorkerRow(
  run: RunPaths,
  workerId: string,
  opts?: WorkerReadOptions,
): Promise<Region<WorkerRead>> {
  const now = opts?.now ?? monotonicMs;
  /*
   * The WALL clock, and the only thing it is used for is `transcriptAgeMs`.
   * See `model.ts`'s two-clocks note: that age's other operand is an ISO stamp
   * written by the supervisor, a different process with no monotonic origin in
   * common, so it is the one comparison here that must be wall clock. It does
   * NOT default to `now` — a fallback that silently borrowed the monotonic
   * clock would make every worker read `wrote 0s ago`, which is the exact
   * failure the split exists to prevent.
   */
  const wallNow = opts?.wallNow ?? Date.now;
  const containers = opts?.containers ?? null;
  const paths = workerPaths(run, workerId);

  let state: WorkerState | null;
  try {
    state = await readWorkerState(paths);
  } catch (err) {
    return failed(message(err), now());
  }
  if (state === null) return never();

  const notes: string[] = [];

  let presentation: Presentation | null = null;
  try {
    presentation = await readPresentation(paths);
  } catch (err) {
    notes.push(message(err));
  }

  let attended: AttendedRecord | null = null;
  try {
    /**
     * Takes `RunPaths` and a worker id rather than `WorkerPaths` — its own
     * signature (`attended/mode.ts:344-347`), which resolves the file through
     * `workerPaths` internally. Calling it is therefore also how this module
     * stays clear of spelling `attended.json` (ISC-471).
     */
    attended = await readAttended(run, workerId);
  } catch (err) {
    /**
     * `AttendedSchemaError` and `StateReadError` are both possible here and
     * are deliberately NOT merged: `attended/mode.ts:317-319` records that
     * reporting both as one class was the defect — one says another build
     * wrote this file, the other says this file is damaged. Carrying
     * `err.message` verbatim keeps the two sentences apart on screen.
     */
    notes.push(message(err));
  }

  let launch: WorkerLaunch | null = null;
  let launchUnreadable = false;
  try {
    launch = await readWorkerLaunch(paths);
  } catch (err) {
    /*
     * A NOTE and a FLAG, not a failed region. The row's other five fields are
     * still true — they come from `state.json` — and what a damaged launch
     * record costs is one column, which the flag turns into `via: null` and
     * the note explains. This is the same trade `presentation` and `attended`
     * take three lines up, for the reason `WorkerEvidence.notes` gives.
     */
    launchUnreadable = true;
    notes.push(message(err));
  }

  /*
   * The fence is the ONE satellite whose failure takes the row down, and the
   * asymmetry is the contract's rather than this module's preference:
   * `model.ts:172-177` says `fence: null` means "no fence has ever been
   * written", full stop, and gives the failed read to "the enclosing Region".
   * A note here would leave `fence: null` on screen carrying a meaning it does
   * not have — a worker holding a live epoch would render as one that has
   * never taken an epoch, which is the direction an action would later be
   * WRONGLY offered in.
   */
  let fence: FenceView | null;
  try {
    fence = await readFenceView(paths);
  } catch (err) {
    return failed(message(err), now());
  }

  const readAt = now();
  return ok(
    {
      row: {
        workerId,
        runId: run.runId,
        phase: state.phase,
        // `wallNow()`, NOT `readAt` — readAt is monotonic. See above.
        transcriptAgeMs: transcriptAgeMs(state, wallNow()),
        containerPresent:
          containers === null ? null : containers.has(workerContainerName(run.runId, workerId)),
        taskId: state.task_id,
        via: deriveVia(launch, launchUnreadable, presentation),
        fence,
        workspace: deriveWorkspace(presentation),
        workspaceName: deriveWorkspaceName(presentation),
      },
      evidence: { state, presentation, attended, launch, launchUnreadable, notes },
    },
    readAt,
  );
}

/**
 * Re-read ONE worker's `state.json`, carrying its satellites forward (§6.3).
 *
 * ## Why only `state.json`, and why that is not a shortcut
 *
 * `presentation.json` is IMMUTABLE AFTER `up` (§2.7, and the field's own
 * docblock above says so), and `attended.json` is written once and never
 * removed (`report/collect.ts:266-268`). Re-reading either on a 500 ms clock
 * would be two syscalls per worker per tick to observe a value that cannot have
 * changed. The mutable half is `state.json`, which the supervisor rewrites
 * every 250 ms — so it is the only file a fast clock has any reason to open.
 *
 * MEASURED: 0.122 ms per worker against 0.35 ms for the full three-file read.
 * At the fleet sizes where the fast clock is admissible at all that is the
 * difference between fitting the budget and not.
 *
 * ## The satellites are CARRIED, never re-derived
 *
 * `prior` comes from the last slow read. Passing it forward rather than
 * defaulting it to `null` matters more than it looks: `activity.ts`'s ladder
 * takes `adoptedTerminal` and `attendedMode` from those two files, and a fast
 * refresh that dropped them would flip every attended worker to `rpc` twice a
 * second — the exact conflation Finding A is about, arriving from the
 * direction of an optimisation. `launch.json` joins them for the same reason
 * and with the same justification: `up` is the only process that writes it,
 * and `up` has already run.
 *
 * ## `fence.json` is the one satellite that is RE-READ, and §6.3 says so
 *
 * The three carried files are immutable after `up`. The fence is not — it is
 * rewritten durably BEFORE every dispatch (`state.ts:718-727`) and again at
 * settle, and §6.3 puts it on the 500 ms clock beside `state.json` for exactly
 * that reason. Carrying it forward would make the `busy`/`replayable` answer
 * as old as the last 30 s walk, which is the one fact a later action key would
 * consult at the moment it mattered most.
 *
 * MEASURED on the operator's runs root, 2026-09-02: the fence read adds
 * **0.032 ms** per worker, taking this function from 0.127 ms to **0.138 ms**.
 * It is that cheap because §2.3's observation holds at scale — 15 of 101 worker
 * directories on this disk hold a `fence.json` at all, so the ordinary case is
 * one `stat` that returns ENOENT and no read. Declared in `clocks.ts`'s
 * `MEASURED_MS` rather than assumed.
 */
export async function refreshWorkerRow(
  run: RunPaths,
  workerId: string,
  prior: WorkerEvidence,
  opts?: WorkerReadOptions,
): Promise<Region<WorkerRead>> {
  const now = opts?.now ?? monotonicMs;
  const wallNow = opts?.wallNow ?? Date.now;
  const containers = opts?.containers ?? null;
  const paths = workerPaths(run, workerId);

  let state: WorkerState | null;
  try {
    state = await readWorkerState(paths);
  } catch (err) {
    return failed(message(err), now());
  }
  // The worker's directory went away between the walk and this tick — a run
  // that ended. `never` rather than `failed`: nothing is wrong, there is just
  // nothing to read, and the caller drops the row.
  if (state === null) return never();

  let fence: FenceView | null;
  try {
    fence = await readFenceView(paths);
  } catch (err) {
    return failed(message(err), now());
  }

  const readAt = now();
  return ok(
    {
      row: {
        workerId,
        runId: run.runId,
        phase: state.phase,
        transcriptAgeMs: transcriptAgeMs(state, wallNow()),
        containerPresent:
          containers === null ? null : containers.has(workerContainerName(run.runId, workerId)),
        taskId: state.task_id,
        /*
         * RE-DERIVED from the carried documents rather than copied off the
         * previous row, and the difference is not cosmetic: one expression in
         * this repository turns a launch record and a presentation record into
         * a `DispatchVia`, and a fast path that copied a value instead would
         * be a second place the answer could come from — which is the shape
         * that goes stale silently when the first one is fixed.
         */
        via: deriveVia(prior.launch, prior.launchUnreadable, prior.presentation),
        fence,
        /*
         * RE-DERIVED from the carried presentation, exactly as `via` above is,
         * and the failure it avoids is worse than `via`'s because it is
         * INVISIBLE IN A ONE-SHOT RENDER. This path runs on the 500 ms clock;
         * a refresh that dropped the workspace would draw a correctly grouped
         * frame for half a second after `up` and then collapse the entire
         * fleet into `no workspace recorded` — a regression an operator sees
         * in a live pane and no `--once` test ever reaches.
         */
        workspace: deriveWorkspace(prior.presentation),
        workspaceName: deriveWorkspaceName(prior.presentation),
      },
      // Fresh state and fence, CARRIED satellites. See the header.
      evidence: { ...prior, state },
    },
    readAt,
  );
}

/**
 * Read a whole run's worker table, one isolated region per worker.
 *
 * The isolation is the point and it is structural: {@link readWorkerRow} owns
 * its own failure, so this function has no `try` at all and therefore no way
 * to widen a blast radius it cannot see.
 *
 * Sequential rather than `Promise.all`. Each worker costs three small reads of
 * files the OS has almost certainly cached — `state.json` is rewritten every
 * 250 ms — so concurrency buys single-digit microseconds and costs the
 * property that a fleet of 500 workers cannot open 1,500 file descriptors at
 * once on a laptop. §3.4 holds the scale question open; opening it wider on
 * the fast clock is not this module's call to make.
 */
export async function readWorkerRows(
  run: RunPaths,
  workerIds: readonly string[],
  opts?: WorkerReadOptions,
): Promise<readonly Region<WorkerRead>[]> {
  const rows: Region<WorkerRead>[] = [];
  for (const id of workerIds) rows.push(await readWorkerRow(run, id, opts));
  return rows;
}

/**
 * Millis since the transcript last grew, or `null` when it never has.
 *
 * Three distinct sources of `null`, all correct and all meaning "no growth has
 * been observed": the worker is not attended (`transcript_activity` is `null`
 * for every worker that is not — `contracts.ts:119-122`); it is attended and
 * has never produced an entry (`last_growth_at` is `null`); or the recorded
 * stamp does not parse. The third is folded in rather than reported because
 * the field is written by this same fleet through a zod-validated schema, so
 * an unparseable stamp is a defect in the writer that a NaN age would hide
 * behind a plausible-looking number.
 *
 * Clamped at zero, on `regionAgeMs`'s reasoning (`model.ts:83-85`): a stamp
 * from the future is a clock skew, and a negative age renders as a transcript
 * that grew in the future.
 */
function transcriptAgeMs(state: WorkerState, now: number): number | null {
  const at = state.transcript_activity?.last_growth_at ?? null;
  if (at === null) return null;
  const parsed = Date.parse(at);
  if (Number.isNaN(parsed)) return null;
  return Math.max(0, now - parsed);
}

/**
 * Where a dispatch to this worker WOULD go — §6.2's refusal surface, D15.
 *
 * ## This is a MIRROR of `dispatch.ts`, arm for arm, and the arms are cited
 *
 * Every branch below is one branch of the real routing, and nothing here is
 * this module's own idea about what should happen:
 *
 * | This function | `dispatch.ts` |
 * |---|---|
 * | `launch === null` -> `"rpc"` | `planDispatch:292` — *"`launch === null` is `rpc`, and that is a correction"* |
 * | `launchPaneMode === "rpc"` -> `"rpc"` | `planDispatch:293-294` |
 * | `launchPaneMode === "unknown"` -> `null` | `planDispatch:296` returns `{kind: "unavailable"}` |
 * | `tui` + no presentation -> `null` | `sendViaPane:523-529` throws *"there is no pane to type into"* |
 * | `tui` + `adopted_terminal` -> `"staged"` | `sendViaPane:541` -> `stageForAdoptedTerminal` |
 * | `tui` + headless or no `surface_ref` -> `null` | `sendViaPane:544-568` throws *"nowhere to go"* |
 * | `tui` otherwise -> `"pane"` | `sendViaPane:570` onward |
 *
 * `launchPaneMode` is IMPORTED from `container/interrupt.ts` rather than
 * restated, which is what `dispatch.ts:286-289` says to do and why: it owns the
 * field-plus-two-marks agreement rule, and "a second copy here is how the CLI
 * and the abort path would start disagreeing about which plane a worker has".
 * A monitor's copy would be the third. **That import is safe for a read-only
 * viewer by construction, not by promise:** `container/interrupt.ts` imports
 * exactly one thing, `type { WorkerLaunch }`, spawns nothing, and builds argv
 * it does not run. The test asserts both halves so the safety is re-checked
 * rather than remembered.
 *
 * ## The two `null`s, and why neither may become `"rpc"`
 *
 * `DispatchVia` has three members and every one of them is a claim that a
 * route EXISTS. Three states here are not routes — a launch record that would
 * not read, an argv whose marks disagree, and a `tui` worker with no
 * addressable surface — and `null` is the only honest rendering of all three.
 * `"rpc"` is the most permissive rung: it is the route with a fence, an epoch
 * and no human in the loop, so an unreadable record rendering as `"rpc"` would
 * put the freest possible answer on the least evidence. `model.ts:271-275`
 * refuses that for `presentation.json` and the same refusal is owed to
 * `launch.json`.
 *
 * ## The measured edge case this function does NOT paper over
 *
 * `activity.ts:29-33` records a worker on this fleet with `attended.json`
 * present and `mode: "tui"` but `adopted_terminal` ABSENT, and the ladder ORs
 * the two fields because of it. **This function does not OR them, and the
 * difference is deliberate.** `dispatch` reads `presentation.adopted_terminal`
 * and nothing else when it chooses the staged route (`sendViaPane:541`), so a
 * `via` column that consulted `attended.json` would report `staged` for a
 * worker `dispatch` would type into — a greyed-out button disagreeing with the
 * command behind it, which is worse than no button. So `via` mirrors and
 * `activity` ORs, they disagree about that one worker, and BOTH are right
 * about their own question. What that disagreement actually reveals is a fact
 * about `dispatch` rather than about this module, and it is recorded in the
 * ISA rather than silently smoothed over here.
 */
export function deriveVia(
  launch: WorkerLaunch | null,
  launchUnreadable: boolean,
  presentation: Presentation | null,
): DispatchVia | null {
  // No answer beats the permissive answer. See the header.
  if (launchUnreadable) return null;
  if (launch === null) return "rpc";

  const mode = launchPaneMode(launch);
  if (mode === "rpc") return "rpc";
  // `unknown` is `planDispatch`'s `unavailable`: the marks disagree and it
  // refuses to guess which control plane the worker has. So does this.
  if (mode !== "tui") return null;

  // From here down the worker is `tui` and `sendViaPane` owns the fork.
  if (presentation === null) return null;
  if (presentation.adopted_terminal) return "staged";
  if (presentation.backend === "headless" || presentation.surface_ref === null) return null;
  return "pane";
}

/**
 * WHICH WORKSPACE THIS WORKER WAS BROUGHT UP IN, out of the record `up` wrote.
 *
 * ## A one-line function, and it exists for the same reason {@link deriveVia}
 * ## does
 *
 * Two call sites need this answer — the slow walk ({@link readWorkerRow}) and
 * the fast refresh ({@link refreshWorkerRow}) — and `refreshWorkerRow`'s own
 * note states the rule they are both held to: an answer re-derived from the
 * carried documents cannot drift from one derived on the walk, whereas a value
 * copied off the previous row is "a second place the answer could come from,
 * which is the shape that goes stale silently when the first one is fixed".
 * One expression in this repository turns a presentation record into a
 * workspace, and it is this one.
 *
 * ## `null` is the answer to three different questions and that is deliberate
 *
 * The record was never written, the record could not be read, or the record
 * says `workspace_ref: null` because the run had no workspace. All three mean
 * *nothing on disk names a workspace for this worker*, which is the only claim
 * the display layer is entitled to make. **They are NOT distinguished here and
 * must not be**: the three differ in why pifleet has no answer, not in what is
 * true of the worker, and a view that split them would invite an operator to
 * read a missing file as a fact about a running agent.
 *
 * What is emphatically not done is defaulting. `model.ts` argues it for
 * `DispatchVia` and the argument transfers unchanged: a worker filed under a
 * console it was never in is worse than one filed under none, because the
 * first is confidently wrong and the second is merely unknown.
 */
export function deriveWorkspace(presentation: Presentation | null): string | null {
  return presentation?.workspace_ref ?? null;
}

/**
 * The workspace's HUMAN NAME, when the record carries one.
 *
 * Separate from {@link deriveWorkspace} rather than returned beside it, because
 * the two are read by different questions: the ref decides which group a worker
 * is IN, the name decides what that group is CALLED. A single function
 * returning a pair would tempt a caller to key a group on the pair, which is
 * the merge bug {@link WorkerRow.workspaceName} warns about — two workspaces
 * sharing a title must stay two groups.
 *
 * ## `null` MUST NOT BE FILLED IN HERE, and the view must not fill it either
 *
 * It means pifleet never recorded a name for this workspace, which today is the
 * ordinary case: `up` records one only when it created and named the workspace
 * itself, and on the adopted path the installed cmux exports no name to read
 * (probed 2026-09-04). The display layer falls back to the REF, which is a
 * worse label and a true one. Inventing a name — deriving it from the run id,
 * from the repo, from anything — would put a plausible wrong word where an
 * operator reads facts.
 *
 * The field is optional in the schema (`contracts.ts`), so every record written
 * before it existed parses and answers `null` here rather than failing the
 * whole presentation read and taking `via` and the activity ladder with it.
 */
export function deriveWorkspaceName(presentation: Presentation | null): string | null {
  return presentation?.workspace_name ?? null;
}

/**
 * The two facts §6.2's third bullet asks for, and nothing else.
 *
 * ## Why this needs a `stat` that `readFence` does not
 *
 * `readFence` (`run/state.ts:709-715`) maps an ABSENT file to `emptyFence()`,
 * which is right for the supervisor — a worker with no fence has taken no
 * epoch, and an empty snapshot is the correct starting state to reason from.
 * It is wrong for a viewer: `model.ts:172-177` reserves `fence: null` for "no
 * fence has ever been written", and an empty `FenceView` is an affirmative
 * claim that one WAS written and is currently idle. Those are different
 * sentences on a row that a later action key would read, so the collapse is
 * undone here rather than inherited.
 *
 * The existence question is asked FIRST because absence is the fleet's ordinary
 * case — §2.3 measured two live workers and *"neither has `fence.json`"* — so
 * the common path is one `stat` that fails and no read at all, rather than a
 * read that fails followed by a `stat` that confirms it.
 *
 * **The race is real, bounded, and named.** A fence written between this `stat`
 * and the read that follows renders as `null` for one fast tick, i.e. 500 ms.
 * The opposite order would trade that for a worse one — a `stat` after a read
 * cannot distinguish "never written" from "written and removed" either, and
 * nothing removes a fence.
 *
 * A read that THROWS propagates, and the caller turns it into a `failed`
 * region. See {@link readWorkerRow}'s note for why that one satellite does not
 * degrade to a note.
 */
export async function readFenceView(paths: WorkerPaths): Promise<FenceView | null> {
  const { stat } = await import("node:fs/promises");
  try {
    await stat(paths.fenceJson);
  } catch {
    return null;
  }
  const snapshot = await readFence(paths);
  return {
    liveTaskId: snapshot.live?.task_id ?? null,
    /*
     * `false` and not `null` when there is no live epoch, because the field is
     * a boolean in the contract and the question it answers — "would an action
     * be refused because an abort is already outstanding" — has the answer
     * `no` for a worker with no epoch. That is a fact, not a default.
     */
    abortRequested: snapshot.live?.abort_requested ?? false,
    attemptCount: Object.keys(snapshot.attempts).length,
  };
}

/**
 * The error's own sentence, which for `StateReadError` is already the
 * diagnosis §6.4 requires on screen — path, zod issue paths, and the bytes
 * (`run/state.ts:786-804`). Only the first line, on `logs.ts:39`'s reasoning:
 * a region reason is one cell, not a stack trace.
 */
function message(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}

/**
 * The refusal surface and the fence for ONE worker, for a caller that wants
 * them without the rest of a row.
 *
 * ## Why this exists rather than view 2 reading the row it already has
 *
 * `WorkerRow` carries `via` and `fence` (ISC-499) and view 2 is a view OF a
 * worker, so the obvious move is for view 2 to read `model.runs` and find its
 * row there. **ISC-503 forbids exactly that** — each view renders only from
 * its own selection — and the prohibition is not bureaucratic: a view 2 that
 * reached into `model.runs` would render a worker the fleet walk had not found
 * yet as though it did not exist, and would silently go blank whenever the
 * slow clock's walk failed for reasons that have nothing to do with the worker
 * on screen.
 *
 * So view 2's payload carries its own copy, and the thing that must not be
 * duplicated is the DERIVATION, not the read. `deriveVia` and `readFenceView`
 * are the single definitions and both are called here — a second `pane_mode`
 * rule in this file would be D10's second adjudicator in the one place an
 * operator looks before acting on a worker.
 */
export async function readRefusalSurface(
  run: RunPaths,
  workerId: string,
): Promise<{ readonly via: DispatchVia | null; readonly fence: FenceView | null }> {
  const paths = workerPaths(run, workerId);

  let launch: WorkerLaunch | null = null;
  let launchUnreadable = false;
  try {
    launch = await readWorkerLaunch(paths);
  } catch {
    // The same trade `readWorkerRow` makes: no answer beats the permissive
    // answer, and `deriveVia` turns this flag into `null` rather than `rpc`.
    launchUnreadable = true;
  }

  let presentation: Presentation | null = null;
  try {
    presentation = await readPresentation(paths);
  } catch {
    presentation = null;
  }

  return {
    via: deriveVia(launch, launchUnreadable, presentation),
    fence: await readFenceView(paths),
  };
}
