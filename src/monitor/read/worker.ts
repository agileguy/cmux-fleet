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
 */

import { failed, never, ok, type Region, type WorkerRow } from "../model.ts";
import { workerContainerName, workerPaths, type RunPaths } from "../../run/paths.ts";
import { readPresentation, readWorkerState } from "../../run/state.ts";
import { readAttended } from "../../attended/mode.ts";
import type { AttendedRecord, Presentation, WorkerState } from "../../contracts.ts";

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
  readonly now?: () => number;
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
  const now = opts?.now ?? Date.now;
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

  const readAt = now();
  return ok(
    {
      row: {
        workerId,
        runId: run.runId,
        phase: state.phase,
        transcriptAgeMs: transcriptAgeMs(state, readAt),
        containerPresent:
          containers === null ? null : containers.has(workerContainerName(run.runId, workerId)),
        taskId: state.task_id,
      },
      evidence: { state, presentation, attended, notes },
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
 * The error's own sentence, which for `StateReadError` is already the
 * diagnosis §6.4 requires on screen — path, zod issue paths, and the bytes
 * (`run/state.ts:786-804`). Only the first line, on `logs.ts:39`'s reasoning:
 * a region reason is one cell, not a stack trace.
 */
function message(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}
