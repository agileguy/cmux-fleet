/**
 * The monitor's model of the fleet: what one tick of reading produces, and
 * what a renderer is allowed to know (SRD-FLEET-MONITOR §6.4, D4, D5, D9).
 *
 * ## Why this file exists before any reader or any view
 *
 * D2 puts Ink behind a `(model) => string[]` seam, and a seam is only worth
 * having if both sides are written against the same contract rather than
 * against each other. This module is that contract. Nothing here imports a
 * reader, a renderer, React or Ink — it is types and two pure helpers — so a
 * test can construct any fleet state as a literal and assert a rendering
 * without a runs directory, a container, or a terminal. **That is ISC-491's
 * requirement expressed as a file layout rather than as a discipline.**
 *
 * ## The one structural decision worth arguing here
 *
 * Every reader's output is wrapped in `Region<T>` rather than returned bare.
 * A bare `T | null` cannot distinguish the three states ISC-478 and ISC-479
 * insist are different — *never read*, *read and empty*, *read and threw* —
 * and the third is the one that makes a monitor lie: a reader that throws and
 * leaves the previous value in place renders a confident stale number with
 * nothing to mark it. The wrapper costs one indirection at every use site and
 * buys a display layer that cannot silently show the last good value.
 *
 * `readAt` is the time the read SUCCEEDED, never the time a frame painted.
 * ISC-477 asserts the difference because the wrong version is the one a
 * reasonable person writes first: an age computed at paint time is always
 * zero, always plausible, and always a lie.
 *
 * ## TWO CLOCKS, AND THEY ARE NOT INTERCHANGEABLE
 *
 * Owner decision, 2026-09-02, taken after the scheduler work surfaced it.
 *
 * - **`Region.readAt` and `FleetModel.now` are MONOTONIC** (`util/clock.ts`'s
 *   `monotonicMs`, i.e. `performance.now`). They exist only to be subtracted
 *   from one another, both stamps come from THIS process, and `util/clock.ts`
 *   is unambiguous that subtracting two wall-clock readings is a bug (ISC-155).
 *   A standing monitor is precisely the thing that sits through an NTP step and
 *   a laptop suspend, so a wall-clock staleness marker would jump by the size
 *   of the sleep the moment the lid opened.
 * - **`WorkerRow.transcriptAgeMs` is derived from WALL CLOCK**, and must be. Its
 *   other operand is an ISO stamp written by the SUPERVISOR — a different
 *   process, with no monotonic origin in common. This is the same exemption
 *   `status.ts:39-45` claims for `ago`, for the same reason.
 *
 * **Mixing them does not produce an error, it produces a plausible number**,
 * which is why every site that touches either says which one it holds.
 * `monotonicMs()` counts from process start, so it is a number in the hundreds
 * while an epoch stamp is ~1.76e12. Subtract the wrong pair and
 * `Math.max(0, …)` clamps the result to `0`: every worker renders `wrote 0s
 * ago` and every region renders `as of 0s`, which is the most reassuring
 * possible frame and entirely false. `test/unit/monitor-clock-units.test.ts`
 * exists for exactly that swap.
 */

/**
 * One reader's result, with enough provenance for the display layer to be
 * honest about it.
 *
 * The three constructors below are the only intended way to build one — not
 * for ceremony, but because `{ status: "ok" }` with a `value` of `undefined`
 * is representable in this shape and means nothing, and a helper that cannot
 * express it is cheaper than a validator that rejects it.
 */
export type Region<T> =
  | {
      readonly status: "ok";
      readonly value: T;
      /** Epoch millis at which THIS read succeeded. Never a paint time. */
      readonly readAt: number;
    }
  | {
      /**
       * The reader ran and threw. `reason` is rendered IN PLACE of the
       * content (ISC-478) — never appended beside a retained previous value,
       * which is the shape that produces a confident wrong number.
       */
      readonly status: "failed";
      readonly reason: string;
      readonly readAt: number;
    }
  | {
      /**
       * The reader has never completed once. Distinct from `ok` with an empty
       * value, which is a reader that looked and found nothing (ISC-479).
       * "I could not look" and "I looked and there was nothing" are different
       * facts and only one of them names a broken monitor.
       */
      readonly status: "never";
    };

export const ok = <T>(value: T, readAt: number): Region<T> => ({ status: "ok", value, readAt });
export const failed = <T>(reason: string, readAt: number): Region<T> => ({
  status: "failed",
  reason,
  readAt,
});
export const never = <T>(): Region<T> => ({ status: "never" });

/**
 * Age in milliseconds of a region's content, or `null` when there is nothing
 * to be old — a region that has never succeeded has no age, and rendering one
 * as `0ms` would be the same lie ISC-477 guards against from the other side.
 *
 * A `failed` region keeps the age of its FAILURE rather than of its last good
 * value, because the last good value is not being shown.
 */
export function regionAgeMs<T>(region: Region<T>, now: number): number | null {
  return region.status === "never" ? null : Math.max(0, now - region.readAt);
}

/**
 * The five activity states of a worker (D9, ISC-480), which exist because the
 * incumbent prints two — `idle` and, in principle, busy — and four of six live
 * workers on the operator's own fleet fall into neither usefully.
 *
 * **`no-transcript` is the state this whole design turned on.** Q1(a) is
 * settled and measured: an attended worker that has never spoken IS
 * distinguishable from an `rpc` worker, through `presentation.adopted_terminal`,
 * the presence of `attended.json`, and `state.json`'s `session_present` — none
 * of which `pifleet status` reads, which is exactly why it cannot make the
 * distinction and why D6 pays for itself.
 *
 * **Q1(b) is NOT settled and this enum must not pretend otherwise.**
 * `no-transcript` means "has never spoken". It does NOT mean "is stuck", and
 * no member of this union means that, because nothing on disk distinguishes a
 * worker that has never spoken from one that is wedged. A sixth member named
 * `wedged` would be a claim the data cannot support.
 */
export type Activity =
  /** Not an attended worker at all; its turns run over the control socket. */
  | "rpc"
  /** Attended, and has never produced a transcript entry. Never "stuck". */
  | "no-transcript"
  /** Has a session file that is not currently growing. */
  | "quiet"
  /** Transcript grew within the growth window. */
  | "active"
  /** Supervisor believes it is live and `docker ps` does not list it (ISC-482). */
  | "container-gone";

/**
 * What the monitor knows about one worker after a tick.
 *
 * `activity` is derived rather than read, and it is derived in exactly one
 * place (`src/monitor/activity.ts`) so that the five-state ladder has a single
 * definition the fixtures in ISC-480 and ISC-481 can pin.
 */
export interface WorkerRow {
  readonly workerId: string;
  readonly runId: string;
  readonly activity: Activity;
  /**
   * `phase` as `state.json` reports it, carried verbatim and NOT reinterpreted.
   * For an attended worker it is permanently `idle` and that is TRUE — no epoch
   * is allocated (`voided.ts:136-140`) — so the monitor shows it beside the
   * activity column rather than instead of it. Collapsing the two is the
   * misreading the incumbent pane produces today.
   */
  readonly phase: string;
  /** Millis since the transcript last grew; `null` when it never has. */
  readonly transcriptAgeMs: number | null;
  /** `true` when `docker ps` listed this worker's container on the last slow tick. */
  readonly containerPresent: boolean | null;
  readonly taskId: string | null;
}

/** One live run and the workers under it. */
export interface RunRow {
  readonly runId: string;
  readonly workers: readonly WorkerRow[];
}

/**
 * The whole model a frame is rendered from. Every field is a `Region` because
 * every field comes from a different reader on a different clock, and a frame
 * that shows a fresh fleet beside a thirty-second-old container set must be
 * able to say so per region rather than carrying one age for the screen.
 */
export interface FleetModel {
  readonly runs: Region<readonly RunRow[]>;
  /** Container names `docker ps` reported, on the slow clock only (D7). */
  readonly containers: Region<readonly string[]>;
  readonly git: Region<GitStrip>;
  /** Epoch millis the frame is being rendered at; the only paint-time value. */
  readonly now: number;
  /** Terminal width the frame must fit (D14, ISC-484, ISC-485). */
  readonly columns: number;
}

/**
 * The git strip's content (§6.8, D12, ISC-486).
 *
 * All five properties the incumbent had are carried. **Which half is shown by
 * default was REVERSED by the owner on 2026-09-02 (Q8): status first, commits
 * behind `[c]`** — dirty paths change and a commit list on an idle branch does
 * not. `commitsExpanded` is the view state that decides which; both halves are
 * always present in the model, so expanding costs no read.
 */
export interface GitStrip {
  /** `git status --short --branch`'s first line. The `--branch` flag is the point. */
  readonly branchLine: string;
  readonly statusLines: readonly string[];
  readonly commitLines: readonly string[];
  /** `watchDir` — the repository being watched, which need not be this one. */
  readonly watchDir: string;
  readonly commitsExpanded: boolean;
}
