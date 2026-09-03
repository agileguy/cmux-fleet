/**
 * View 2: one worker, in the depth view 1 has no room for
 * (SRD-FLEET-MONITOR §6.2 View 2, §2.4, D8).
 *
 * ## Two readers, both already written, and nothing new between them
 *
 * `readEventTail` (`read/events.ts:135`) owns the bounded window and the
 * argument for it — §2.4 measured a single `events.jsonl` at **24.7 MB across
 * 8,336 lines**, and the log is asymmetric, so the expensive case is the
 * ordinary one for exactly the workers an operator most wants to open. It also
 * owns why `TailReader` is refused here: its first poll starts at offset 0 and
 * reads the whole file, which is the read this design forbids and the one a
 * reviewer would not see because every subsequent tick is a delta.
 *
 * `readWorkerState` (`run/state.ts:55`) owns the counters. `WorkerDetail` wants
 * five values off it and every one is a plain read — `phase`, `turns`,
 * `usage.input_tokens`, `usage.output_tokens`, `credential.degraded` and
 * `exit`. There is no arithmetic in this file and there should not be: a total
 * computed here would be a second opinion about a number the supervisor
 * publishes.
 *
 * ## The lines are NOT rendered here, and that is `events.ts`'s decision kept
 *
 * `logs.ts:66-100` already solved the legibility half — `RENDER_CLIP = 400`,
 * the C0/C1 control-character class, and a `sanitize` that REPLACES rather than
 * strips so *"a visible U+FFFD tells the operator content was withheld, where
 * silent removal would present doctored text as verbatim"*. `read/events.ts`
 * returns raw lines so the display layer can reuse that function rather than
 * grow a second one, and this module passes them through unchanged for the same
 * reason. `model.ts:320-322` states the rule from the contract's side: *"a
 * second set of clipping rules is a second spelling of one fact"*.
 *
 * ## Why this is on NO CLOCK either
 *
 * It is entered, like views 3 and 4. It is much cheaper than either — a
 * bounded window and one small file — so the reason is not cost, it is
 * SELECTION: `WorkerDetail` describes one worker, and until the operator has
 * chosen one there is no worker to describe. `never()` is the honest region for
 * that, and `model.ts:216` says so: `never` while no worker is selected.
 */

import { monotonicMs } from "../../util/clock.ts";
import { failed, never, ok, type Region, type WorkerDetail } from "../model.ts";
import { workerPaths, type RunPaths } from "../../run/paths.ts";
import { readWorkerState } from "../../run/state.ts";
import { readEventTail } from "./events.ts";
import type { WorkerState } from "../../contracts.ts";

export interface ReadWorkerDetailOptions {
  /** Forwarded to `readEventTail`, which clamps it. Defaults to its default. */
  readonly windowBytes?: number;
  /** MONOTONIC, for `readAt`. */
  readonly now?: () => number;
}

/**
 * Read one worker's detail view.
 *
 * ## The three region statuses, and which fact produces each
 *
 * - **`never`** — no `state.json`. The same answer `read/worker.ts` gives for
 *   the same input and for the same reason: `WorkerDetail.phase` is
 *   `PhaseSchema`'s six-member enum carried verbatim, and there is no seventh
 *   member meaning "no state file". Synthesising one would put a
 *   monitor-invented value in a field documented as the supervisor's own word.
 * - **`failed`** — `state.json` exists and would not parse. `StateReadError`
 *   already carries the path, the zod issue paths and the bytes, and §6.4
 *   requires that sentence on screen in place of the content.
 * - **`ok`** — everything else, INCLUDING a worker with no `events.jsonl` at
 *   all. That is normal — the supervisor creates the log lazily — so it is
 *   `eventsPresent: false` inside an `ok` region, which is "I looked and there
 *   was nothing" rather than "I could not look" (`model.ts:82-88`).
 *
 * **A failed EVENT read does not fail the region, and the asymmetry is
 * deliberate.** The counters, the credential health and the exit detail all
 * come from `state.json` and are still true when the log is unreadable; the
 * view's whole subject is *"which worker died and why"*, and answering it with
 * an exit code and no events beats answering it with an error and neither.
 * The empty `eventLines` is marked by `eventsPresent`, so the display layer can
 * tell an unreadable log from a quiet one.
 */
export async function readWorkerDetail(
  run: RunPaths,
  workerId: string,
  opts?: ReadWorkerDetailOptions,
): Promise<Region<WorkerDetail>> {
  const now = opts?.now ?? monotonicMs;
  const paths = workerPaths(run, workerId);

  let state: WorkerState | null;
  try {
    state = await readWorkerState(paths);
  } catch (err) {
    return failed(firstLine(err), now());
  }
  if (state === null) return never();

  const tail = await readEventTail(
    paths,
    opts?.windowBytes === undefined ? { now } : { windowBytes: opts.windowBytes, now },
  );

  return ok(
    {
      workerId,
      runId: run.runId,
      // `ok` -> the window's lines; anything else -> no lines and
      // `eventsPresent: false`. See the header: the log's failure is one cell,
      // not the row.
      eventLines: tail.status === "ok" ? tail.value.lines : [],
      clippedHead: tail.status === "ok" && tail.value.clippedHead,
      eventsPresent: tail.status === "ok" && tail.value.present,
      phase: state.phase,
      turns: state.turns,
      inputTokens: state.usage.input_tokens,
      outputTokens: state.usage.output_tokens,
      /*
       * `credential === null` means NO CREDENTIAL WAS PLANNED, which is a
       * decision rather than a degradation (`contracts.ts:420-424`), so it
       * becomes `null` here and not `false`. `false` is the affirmative claim
       * that a credential exists and is healthy, and rendering "not degraded"
       * for a worker that was never given one would answer a question nobody
       * asked with a reassurance nobody earned.
       */
      credentialDegraded: state.credential === null ? null : state.credential.degraded,
      /*
       * `state.exit` is NOT nullable in the schema — it defaults to
       * `{code: null, signal: null}` — but `WorkerDetail.exit` is, and
       * `model.ts:339` says the field carries `state.exit` "when the worker has
       * one". A worker still running has an exit object full of nulls, and
       * passing that through would let a display layer print `exit code: none`
       * beside a live worker, which reads as a worker that exited without a
       * code. So the all-null shape collapses to `null` here, once, rather than
       * being re-detected at every paint.
       */
      exit:
        state.exit.code === null && state.exit.signal === null
          ? null
          : { code: state.exit.code, signal: state.exit.signal },
    },
    now(),
  );
}

/** One line of diagnosis — a region reason is one cell (`read/worker.ts`). */
function firstLine(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}
