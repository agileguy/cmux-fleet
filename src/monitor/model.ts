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
  /**
   * How a dispatch WOULD reach this worker (§6.2, D15). Read, never acted on.
   * `null` when `presentation.json` is absent or unreadable — see
   * {@link DispatchVia} for why that is not defaulted to `"rpc"`.
   */
  readonly via: DispatchVia | null;
  /**
   * Whether an action would be refused `busy` or replayed (§6.2). `null` when
   * `fence.json` has never been written, which is the normal state of a worker
   * that has taken no epoch — distinct from a fence read that threw, which the
   * enclosing region carries.
   */
  readonly fence: FenceView | null;
  /**
   * WHICH WORKSPACE `up` BROUGHT THIS WORKER UP IN — `presentation.json`'s
   * `workspace_ref`, carried verbatim.
   *
   * ## Why the record and not cmux
   *
   * The obvious source is cmux itself: enumerate workspaces, list their panes,
   * map pane back to worker. **That source is wrong here, and the reason is
   * this project's own operating rule** — *"the consoles are not the fleet.
   * Workers survive a closed cmux window; `status --all` is the truth, a
   * visible pane is not."* A worker whose window the operator closed an hour
   * ago is still running, still holding an epoch, and still the row most worth
   * finding; cmux no longer knows it exists. Grouping by what cmux can see
   * would drop exactly those workers, at exactly the moment the monitor earns
   * its keep.
   *
   * `presentation.json` is written once by `up` (`cli/commands/up.ts:2224`) and
   * is IMMUTABLE thereafter (§2.7). It is a fact on disk, so a closed window, a
   * quit cmux and an uninstalled cmux are all the same to it. It also costs
   * nothing: `read/worker.ts` already parses that file for the activity
   * ladder, so this field adds no read, no subprocess, and no import — which
   * keeps ISC-469's pin at one spawning module rather than making the viewer
   * shell out to a second tool.
   *
   * ## `null` is a real population, not a defensive branch
   *
   * MEASURED across the operator's own 226 run directories on 2026-09-04: of
   * 183 `presentation.json` records, **81 carry `workspace_ref: null`** — a
   * headless run, a record written before the field existed, or a
   * presentation that could not be read at all. `null` means *no workspace was
   * ever recorded for this worker*, which is a positive fact about the record
   * and NOT a claim that the worker is detached, dead or unreachable.
   *
   * It is never defaulted. There is no permissive value to fall back to, and a
   * worker filed under a console it was never in is worse than one filed under
   * none — the same argument {@link DispatchVia} makes for refusing to default
   * to `"rpc"`.
   */
  readonly workspace: string | null;
  /**
   * The workspace's HUMAN NAME — `presentation.json`'s `workspace_name`, which
   * is cmux's `custom_title` and round-trips the `--name` pifleet created the
   * workspace with.
   *
   * ## It LABELS, it never IDENTIFIES — and the split is the whole point
   *
   * {@link WorkerRow.workspace} is the group KEY: a UUID, unique and stable.
   * This is the group's LABEL. Grouping on the name instead would merge two
   * distinct workspaces that happen to share a title, and nothing stops an
   * operator from having two called `review`. So identity stays the ref and the
   * name is only ever what gets printed.
   *
   * ## `null` is the ordinary case today, and the view falls back to the ref
   *
   * Recorded only when pifleet created and named the workspace. On the
   * `up --attach-here` path — which is EVERY run on the operator's disk
   * (measured 2026-09-04: 179 of 179 carry `backend: headless` with
   * `adopted_terminal: true`) — the workspace is one cmux already owned, and
   * all pifleet learns is the UUID in `CMUX_WORKSPACE_ID`; the installed cmux
   * exports no name variable at all. Every record written before the field
   * existed is `null` too.
   *
   * **A name is never invented to fill this.** A UUID is obviously an
   * identifier; a fabricated label reads as a fact.
   */
  readonly workspaceName: string | null;
}

/** One live run and the workers under it. */
export interface RunRow {
  readonly runId: string;
  readonly workers: readonly WorkerRow[];
  /**
   * What this run's workers are ACTUALLY running, as `provider/model`, in
   * worker order and de-duplicated — `[]` when nothing recorded one.
   *
   * Read from the run's own `run.json`, never re-resolved from `fleet.yaml`.
   * The distinction is the whole point: `fleet.yaml` answers "what would this
   * worker run if launched today", and an operator who edits a role's `model:`
   * mid-run must not see the new value printed beside a container still
   * running the old one. `up.ts` records it for the same reason it records
   * `repo` and `branch_prefix`.
   *
   * `[]` for a run created before the key existed, which the view renders as
   * nothing at all rather than as a guess.
   */
  readonly models: readonly string[];
  /**
   * Why {@link models} is empty when the emptiness is a FAILURE — or `null`,
   * which is every ordinary run.
   *
   * ## Two empties that must not look alike
   *
   * `models: []` has two causes and only one of them is normal. A run created
   * before `up` recorded `worker_models` has no such key and never will: it is
   * empty because there is nothing to say, and the view prints nothing, which
   * is right. A `run.json` that will not parse is empty because the monitor
   * COULD NOT LOOK, and printing nothing there makes the viewer the one
   * surface in the fleet where a damaged control-plane document renders as an
   * ordinary line.
   *
   * That is `Region`'s own distinction at the top of this file — *read and
   * empty* versus *read and threw* — arriving one level down, on a field
   * rather than on a reader's whole output. A `Region<readonly string[]>` here
   * would say it with the existing type, and was rejected for a concrete
   * reason: a region carries a `readAt`, and this value has no read time of its
   * own — it is produced inside the run walk whose stamp the enclosing region
   * already carries, so the field would have to invent a timestamp to fill.
   *
   * ## The invariant, stated because two fields can contradict each other
   *
   * A non-`null` note implies `models` is `[]`. `read/runs.ts` is the only
   * producer and cannot break it — the reader returns no models on the path
   * that produces a note — and the view resolves the impossible pairing by
   * preferring the note, because a reason beside a value is the shape ISC-478
   * refuses.
   */
  readonly modelsNote: string | null;
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
  /** Epoch millis the frame is being rendered at; the only paint-time value. */
  readonly now: number;
  /** Terminal width the frame must fit (D14, ISC-484, ISC-485). */
  readonly columns: number;
  /**
   * Which of §6.2's four views this frame renders, and what it is pointed at.
   *
   * Defaulting to `{ kind: "fleet" }` is ISC-483's requirement expressed in the
   * model: the first frame answers §1.3's first two questions with no input.
   */
  readonly view: ViewState;
  /**
   * View 3's rows. **`never` until the operator enters history**, because D8
   * makes live the view and history a mode you enter — a monitor that walked
   * 80 run directories to render a fleet nobody asked it to leave would pay
   * Q5's cost on every tick for a view that is not on screen.
   */
  readonly history: Region<readonly RunHistoryRow[]>;
  /** View 2's payload. `never` while no worker is selected. */
  readonly detail: Region<WorkerDetail>;
  /**
   * View 4's payload, as `renderRunReport` already formats it — carried as
   * LINES rather than as a `CollectedReport` (D10, §6.2 View 4).
   *
   * The monitor must render the report "in `renderRunReport`'s own order and
   * with its own wording rules preserved", including the verbatim `"would
   * merge cleanly … as of this check — NOT merged"`. Re-implementing that
   * formatting here would be a second renderer of one fact and would let the
   * two spellings drift; taking the existing renderer's output means the
   * wording is pinned by the criterion that already guards it. `never` until
   * the operator asks for a report, which is §5.3's explicit key.
   */
  readonly report: Region<readonly string[]>;
}


/* ────────────────────────────────────────────────────────────────────────────
 * Views 2-4 and the selection model (§6.2, D8, §5.3).
 *
 * Everything below this line exists because §6.2 names four views and the
 * branch carries all four (§5.1, SCOPE CONFIRMED). View 1's types are above;
 * these are the three that need a selection to mean anything.
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * Whether a dispatch addressed to this worker would go over the socket, be
 * typed into a pane, or be staged — §6.2's second "must be able to see".
 *
 * **This is on `WorkerRow` rather than on the worker detail view, and that is
 * the whole point of it.** §6.2 asks for the refusal surface so that "a later
 * action button has somewhere to be greyed out and a reason to give", and a
 * button lives on a row. Carrying it only in view 2 would mean the fleet view
 * shows a set of rows none of which knows whether it could be acted on, which
 * is precisely the redesign D15 says adding actions must not require.
 *
 * `null` when `presentation.json` is absent or unreadable — not `"rpc"`.
 * Defaulting to the permissive rung would be the reassuring lie `model.ts:36`
 * warns about, wearing different clothes: an unreadable presentation record
 * would render as the worker most freely dispatchable.
 */
export type DispatchVia = "rpc" | "pane" | "staged";

/**
 * What `fence.json` says about whether an action would be refused `busy` or
 * replayed — §6.2's third "must be able to see".
 *
 * Deliberately NOT the whole `FenceSnapshot`. The monitor shows two facts: is
 * an epoch live, and how many attempts have been accepted. `completed`,
 * `ack_seq` and `last_seq` are forensic fields that belong to `report` and
 * would put a per-worker unbounded array in a model rendered twice a second.
 */
export interface FenceView {
  /** `task_id` of the live epoch, or `null` when no epoch is outstanding. */
  readonly liveTaskId: string | null;
  /** `true` when the live epoch has been aborted but not yet settled. */
  readonly abortRequested: boolean;
  /** `Object.keys(attempts).length` — how many `(task, attempt)` pairs exist. */
  readonly attemptCount: number;
}

/**
 * One row of view 3, the run history (§6.2 View 3).
 *
 * Built from `runIdsAscending` — Finding C's "only correct enumeration" — and
 * reversed for display, never sorted by mtime. The distinction matters because
 * a run directory's mtime moves when anything under it is written, so an
 * mtime sort silently reorders history whenever an old run is touched.
 */
export interface RunHistoryRow {
  readonly runId: string;
  /** Millis since the run id's own timestamp. WALL CLOCK — the id is a stamp. */
  readonly ageMs: number;
  readonly workerCount: number;
  /** `true` when at least one worker under it is live. */
  readonly live: boolean;
  /** Documents in `inbox/`. */
  readonly taskCount: number;
  /** Documents in `tasks/` — settled, i.e. adjudicated. */
  readonly settledCount: number;
}

/**
 * View 2's payload: one worker, in the depth view 1 has no room for.
 *
 * The event lines arrive already sanitised and clipped by `logs.ts`'s existing
 * rules rather than re-clipped here (§6.2 View 2). A second set of clipping
 * rules is a second spelling of one fact, which is the hazard ISC-345 names.
 */
export interface WorkerDetail {
  readonly workerId: string;
  readonly runId: string;
  /** Oldest first, already sanitised. Bounded by `readEventTail`'s window. */
  readonly eventLines: readonly string[];
  /** True when earlier events exist above the window — never hidden (§6.4). */
  readonly clippedHead: boolean;
  /** `false` when `events.jsonl` does not exist yet, which is NORMAL. */
  readonly eventsPresent: boolean;
  readonly phase: string;
  readonly turns: number | null;
  readonly inputTokens: number | null;
  readonly outputTokens: number | null;
  /** `state.credential.degraded` — a fact about the worker, surfaced not buried. */
  readonly credentialDegraded: boolean | null;
  /** `state.exit`, when the worker has one. */
  readonly exit: { readonly code: number | null; readonly signal: string | null } | null;
  /**
   * The refusal surface and the fence, CARRIED HERE AS WELL AS ON THE ROW.
   *
   * Not a duplicate of `WorkerRow.via`/`fence` by oversight — a duplicate on
   * purpose, because ISC-503 forbids a view from reading another view's
   * region. View 2 holding its own copy is what lets it render a worker the
   * fleet walk has not found yet, and stops it going blank when that walk
   * fails for reasons unrelated to the worker on screen. The DERIVATION is not
   * duplicated: `read/worker.ts`'s `deriveVia` and `readFenceView` are the
   * single definitions and `readRefusalSurface` calls both.
   *
   * View 1 does NOT render these, and that is deliberate rather than pending.
   * §6.5's ladder already drops columns at narrow widths, and two more cells
   * on a row that is shedding cells would be dropped first and read never.
   * View 2 is where an operator goes before acting on a worker, which is the
   * moment §6.2's "somewhere to be greyed out and a reason to give" is about.
   */
  readonly via: DispatchVia | null;
  readonly fence: FenceView | null;
}

/**
 * Which view the frame is rendering, carrying its own selection.
 *
 * **A discriminated union rather than a `view` string beside a nullable
 * `selection`.** The flat shape can represent `{ view: "worker", selection:
 * null }`, which names no worker and cannot be rendered, so every consumer
 * would need a branch for a state the design never intends. This is the same
 * argument `Region`'s three constructors make at the top of this file: a shape
 * that cannot express the meaningless case is cheaper than a validator that
 * rejects it.
 *
 * `fleet` and `history` carry no selection because they ARE the selectors.
 */
export type ViewState =
  | { readonly kind: "fleet" }
  | { readonly kind: "worker"; readonly runId: string; readonly workerId: string }
  | { readonly kind: "history" }
  | { readonly kind: "report"; readonly runId: string };
