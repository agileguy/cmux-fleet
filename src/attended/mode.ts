/**
 * Entering and leaving `tui` pane mode (SRD §3.5, §16 Phase 6).
 *
 * `tui` hands a worker's pane to a person: the pane stops running the
 * read-only viewer and runs an interactive shell inside that worker's
 * container instead. `--leave` hands it back. The container, the supervisor
 * and the RPC stream are untouched throughout — this module drives the
 * PRESENTATION plane only, which is why harvest still succeeds afterwards.
 *
 * The record is the point. A run a person touched must never be able to
 * present as unattended, so the two operations are ordered around one
 * asymmetry:
 *
 * - **Enter writes the record BEFORE respawning the pane.** If the respawn
 *   then fails, the record overclaims — it says attended when the person
 *   never got the pane. That is the safe direction: the report degrades
 *   trust in a run that deserved it.
 *
 * - **Leave respawns the pane BEFORE recording `left_at`.** If the record
 *   write then fails, the record still says attended — again the safe
 *   direction. The other order would mark the session over while the person
 *   still had their hands in the container, which is the exact lie this
 *   subsystem exists to prevent.
 *
 * `--leave` sets `left_at`; it never deletes the file. Whether a human typed
 * into a pane is a fact about the RUN, not about what the pane is doing now.
 */

import { join } from "node:path";
import {
  AttendedRecordSchema,
  EXIT,
  type AttendedRecord,
  type PaneMode,
} from "../contracts.ts";
import { workerPaths, type RunPaths } from "../run/paths.ts";
import { StateReadError } from "../run/state.ts";
import { writeJsonAtomic } from "../util/jsonl.ts";
import type { PaneRef } from "../backends/types.ts";
import { TUI_VOIDED } from "./voided.ts";

/**
 * The one backend method mode-switching needs. Narrowed from `FleetBackend`
 * so unit tests can prove the write/respawn ORDERING with a two-line fake —
 * the ordering is the load-bearing part, and it is only observable when the
 * respawn can be made to fail on cue.
 */
export interface PaneDriver {
  attachViewer(p: PaneRef, argv: string[]): Promise<void>;
}

/** Thrown for operator mistakes (`--leave` on a worker never entered). */
export class AttendedModeError extends Error {
  readonly exitCode = EXIT.USAGE;
  constructor(message: string) {
    super(message);
    this.name = "AttendedModeError";
  }
}

/**
 * The stamp this build writes into `attended.json` and the only one it reads
 * back (ISC-192). Restated as a value for the reason `control-auth.ts` gives
 * for its own: a refusal NAMES this, a `parse` COMPARES the schema's literal,
 * and the operator-facing sentence should not depend on zod's internals.
 */
export const ATTENDED_SCHEMA = "pifleet.attended/v1";

/**
 * An `attended.json` written by a build whose stamp this one does not read
 * (ISC-192) — as opposed to one that is damaged.
 *
 * Its own class rather than a `StateReadError` with different words, on
 * `down.ts`'s `identity_legacy_format` argument: reporting a version skew as
 * corruption asserts something false about the world and sends the operator to
 * the disk to look for damage that is not there.
 *
 * WHY THIS ONE MATTERS MORE THAN ITS NEIGHBOURS. `attended: []` in a run
 * report is an AFFIRMATIVE claim that nobody drove this run by hand, and the
 * whole subsystem exists so that claim cannot be made falsely. A reader that
 * answered an unrecognised stamp with `null` — the "consistency refactor" that
 * `report-collect.test.ts` already records as the dangerous mutation — would
 * turn a record written by another build into "never attended", silently
 * upgrading the trustworthiness of work a human touched.
 *
 * THE HATCH is therefore NOT "ignore the file". `collectRunReport` catches
 * this and lists the worker under `attendedUnverified`, so the run still
 * presents as one whose attendance could not be verified rather than as an
 * autonomous one. To read the record itself, use the build that wrote it —
 * named in the message, because a refusal an operator cannot act on trains
 * them to reach past it.
 *
 * NO UPGRADER. A `v0` record's `voided` table describes which guarantees THAT
 * build believed a human's keystrokes invalidated, and this build's
 * `TUI_VOIDED` is a different list. Re-stamping would keep the old table under
 * a new name and re-deriving it would rewrite history — either way the file
 * would stop describing what actually happened, which is the one thing it is
 * for.
 */
export class AttendedSchemaError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;

  constructor(
    readonly path: string,
    readonly found: string,
  ) {
    super(
      `${path} is stamped ${found}, but this build reads ${JSON.stringify(ATTENDED_SCHEMA)}; ` +
        `the record cannot be re-stamped without rewriting what a person actually voided, so read it ` +
        `with the build that wrote it — until then this worker reports as attendance-UNVERIFIED, ` +
        `never as unattended`,
    );
    this.name = "AttendedSchemaError";
  }
}

/**
 * The worker's container name, as `config/render.ts` builds it for
 * `docker run --name` (SRD §3.4). Duplicated rather than imported because the
 * renderer computes it inline mid-argv and exporting it from there is outside
 * this phase's edit surface — the same consolidation debt ISC-188/ISC-231
 * track for run paths, and the integration suite pins the two spellings
 * against each other through a live `up`.
 */
export { workerContainerName } from "../run/paths.ts";
import { workerContainerName } from "../run/paths.ts";

/**
 * What the pane runs while a person owns an **rpc** worker: an interactive
 * shell inside the worker's container — same workspace, same tools, same
 * (absent) credentials.
 *
 * NOT `docker attach`, **for an `rpc` worker**. That worker's Pi is launched
 * with `--mode rpc` and the supervisor holds stdin as a pipe, so attaching a
 * human keyboard to a JSONL protocol stream would corrupt the control plane on
 * the first keystroke. `docker exec` gives the person hands inside the same
 * boundary without touching Pi's pipes, which is what keeps dispatch, abort and
 * harvest working while the pane is attended.
 *
 * ## The refusal was RESTATED, not relaxed (TUI spec item 9)
 *
 * It used to read as a flat rule — "NOT `docker attach`" with no worker named —
 * and as a flat rule it is now false. It was written when every worker was an
 * rpc worker, so the qualifier cost nothing and was left off. `pane_mode: tui`
 * makes the qualifier load-bearing: a tui worker omits `--mode rpc`, has no
 * JSONL stream, and no supervisor holding its stdin (`supervisor/index.ts`
 * launches it detached and tracks it by name), so there is nothing for a
 * keystroke to corrupt. Its TTY is the whole point of the mode.
 *
 * The refusal still governs every rpc worker, which is every worker a default
 * config produces, and `attachArgv` below is the ONLY sanctioned exception.
 * Nothing here became optional; it acquired the scope it always had.
 */
export function interactiveArgv(runId: string, workerId: string): string[] {
  return ["docker", "exec", "-it", workerContainerName(runId, workerId), "bash"];
}

/**
 * The sequence that detaches a pane from a tui worker — **measured, not
 * chosen** (TUI spec item 4).
 *
 * `docker attach` defaults to `ctrl-p,ctrl-q`, and **Pi binds ctrl-p.**
 * Measured 2026-08-31 against the real image
 * (`pifleet/pi-worker:0.79.6-base-28cde8879cf9`), one fresh container in the
 * tui shape per arm, the attach client on a real pty, one byte delivered per
 * arm. The signal is bytes the TUI emits in the 4 s after delivery — a bound
 * key repaints, an ignored one is silent:
 *
 *   control: nothing delivered              delta =    0   (noise floor is 0)
 *   '/'      (a documented Pi keybind)      delta = 3602   (instrument works)
 *   ctrl-p   (0x10)                         delta = 5153   -> "Only one model
 *                                                             available"
 *   ctrl-]   (0x1d), passed through to Pi   delta =   10   (no visible text)
 *
 * The negative control fixes the noise floor at zero and the positive control
 * proves the instrument can see a reaction at all, so ctrl-p's 5153 bytes are
 * a reaction and ctrl-]'s 10 are not. ctrl-p drives Pi's MODEL SWITCHER; its
 * repaint says so in as many words. Left on the default, an operator reaching
 * for that keybind would arm docker's detach state machine instead, and a pane
 * that eats a keybind of the program it is showing is a broken pane.
 *
 * `ctrl-]` was then proven to work as an escape hatch rather than merely to be
 * ignored, with a control arm that differs in ONE variable — the byte sent:
 *
 *   --detach-keys=ctrl-]  send 0x1d   client detached = YES, worker alive
 *   --detach-keys=ctrl-]  send 'x'    client detached = NO   (control)
 *
 * Without that control the detach arm's exit would equally support "this
 * client exits on any input".
 *
 * WHY ctrl-] AND NOT ctrl-\, which is also unbound. `container/interrupt.ts`
 * records two windows where Pi's raw mode does NOT hold — container startup
 * before Pi sets it, and Pi's `!` bash escape. ISIG is on in those windows, so
 * ctrl-\ is SIGQUIT to the pty's foreground group, which the entrypoint's
 * `trap forward TERM INT HUP` turns into a dead worker. ctrl-] is 0x1d, which
 * no termios control character claims in either mode, and it is the escape
 * telnet and rlogin have used for the same job for decades.
 *
 * **DOES NOT CLAIM** that ctrl-] is unbound in every future Pi. It is unbound
 * in 0.79.6, which is the version this image pins; a Pi that binds it would
 * need this measurement re-run, which is why the arms are written down rather
 * than summarised as "we picked ctrl-]".
 */
export const DETACH_KEYS = "ctrl-]";

/**
 * How long the pane waits for its container before giving up, in seconds.
 *
 * The wait exists because of a REAL ordering, read out of `up.ts` rather than
 * assumed: the pane is created, then the supervisor is launched with
 * `launchDetached`, then this argv is attached. `launchDetached` returns when
 * the supervisor PROCESS is spawned — the supervisor then reads the launch
 * record and runs `docker run -d` itself, so at attach time the container
 * reliably does not exist yet. A bare `docker attach` here would not race; it
 * would fail every single time with `No such container`.
 *
 * Two minutes because the first container of a run pays for image checks and
 * mount setup, and because the cost of waiting too long is a pane that says it
 * is waiting, while the cost of waiting too little is a pane that gives up on
 * a worker that was about to start.
 */
export const ATTACH_WAIT_SECONDS = 120;

/**
 * What a **tui** worker's pane runs: `docker attach` onto Pi's own TTY.
 *
 * This is the exception `interactiveArgv`'s docblock names, and it is the
 * whole of spec item 9. A tui worker's container is created detached with
 * `-i -t` and Pi runs its default (TUI) mode on a pseudo-TTY inside; attaching
 * is what puts that terminal in the operator's pane. `docker exec … bash`
 * would give a shell NEXT TO Pi, which is a different and useless thing here —
 * the operator would be looking at a prompt while the agent they came to drive
 * runs unseen on a terminal nobody holds.
 *
 * ## It waits for the container rather than racing it
 *
 * See `ATTACH_WAIT_SECONDS` for the ordering that makes this mandatory. The
 * wait is the same shape as the two the viewer already uses for the same class
 * of reason — `tail -F` over a file that need not exist, and `logs --follow`
 * waiting for an events file the supervisor has not written yet. A pane whose
 * first act is to fail is not a pane.
 *
 * The give-up is LOUD and the pane SURVIVES it. On timeout the pane prints
 * which container it waited for and how long, and does not exit — an operator
 * who finds an empty pane learns nothing, and one whose pane vanished cannot
 * even read the diagnosis. `up` records a failed viewer and carries on either
 * way; that non-fatal property is preserved here rather than relied upon.
 *
 * ## The container name is an ARGUMENT, never shell syntax
 *
 * `sh -c <script> <argv0> <name>` puts the name in `"$1"`. Interpolating it
 * into the script would make every run id and worker id shell syntax, which is
 * the same mistake `backends/cmux/index.ts` describes at length in
 * `attachViewer` — it writes the argv to a 0700 script and spawns it by path
 * precisely so that config strings never become code.
 *
 * **DOES NOT CLAIM** the pane outlives the worker. When Pi exits, the attach
 * ends and the pane closes with it — SRD §3.5 already records this as voided
 * in `tui` ("closing a pane doesn't stop the worker" is false here; the pane
 * owns the attach). The final screen is lost with it, and the transcript, not
 * the pane, is where a finished tui worker is read.
 */
export function attachArgv(runId: string, workerId: string): string[] {
  const container = workerContainerName(runId, workerId);
  // `"$1"` throughout: see the docblock. `exec` so the pane's process IS the
  // attach — no stray shell per pane, and signals reach docker unchanged.
  const script =
    `n=0; ` +
    `while [ "$n" -lt ${ATTACH_WAIT_SECONDS} ]; do ` +
    `if [ "$(docker inspect -f '{{.State.Running}}' "$1" 2>/dev/null)" = true ]; then ` +
    `exec docker attach --detach-keys=${DETACH_KEYS} "$1"; ` +
    `fi; ` +
    `n=$((n+1)); sleep 1; ` +
    `done; ` +
    `echo "pifleet: container $1 did not start within ${ATTACH_WAIT_SECONDS}s; ` +
    `nothing to attach to. The worker may have failed to launch - see supervisor.log."; ` +
    // Hold the pane open so the line above can actually be read.
    `while true; do sleep 3600; done`;
  return ["sh", "-c", script, "pifleet-attach", container];
}

/** Resolved relative to this module so the CLI entry needs no lookup. */
const CLI_ENTRY = join(import.meta.dir, "..", "cli", "index.ts");

/**
 * The read-only viewer `--leave` restores — the same line `up` starts panes
 * with. `env PIFLEET_RUNS_DIR=…` and an explicit `--run` for the same reason
 * `up` passes them: the pane is a child of a long-lived tmux/cmux server that
 * predates this run, so an ambient-environment viewer would tail the wrong
 * fleet. Duplicated from `up.ts` because that file is outside this phase's
 * edit surface; the tui integration test runs a live `up`, enters and leaves,
 * and requires the restored pane to match what `up` launched, which is what
 * keeps the two copies from drifting apart silently.
 */
export function viewerArgv(runsRoot: string, runId: string, workerId: string): string[] {
  return [
    "env",
    `PIFLEET_RUNS_DIR=${runsRoot}`,
    process.execPath,
    CLI_ENTRY,
    "logs",
    "--worker",
    workerId,
    "--run",
    runId,
    "--follow",
    "--render",
  ];
}

/**
 * Read a worker's attended record; `null` when the run was never attended.
 *
 * THREE ANSWERS, and only one of them is `null`. Absence means the pane was
 * never handed to a person, which is a real and common state. The other two
 * are refusals, kept apart because they are acted on differently:
 * `AttendedSchemaError` says another build wrote this file, `StateReadError`
 * says this file is damaged. Both were reported as `StateReadError` before
 * ISC-192, which conflated "upgrade your binary" with "look at your disk".
 *
 * IT VALIDATES, AND THE VALIDATION IS NOT OPTIONAL. `doc` is deliberately
 * `unknown` between the two steps and is never handed back untyped, because
 * every consumer of this record makes a decision on its contents that it is
 * not safe to make on unparsed JSON:
 *
 *  - `leaveTui` branches on `existing.mode !== "tui"`. An untyped `doc` lets a
 *    hand-edited or foreign file put any value there, and the guard that stops
 *    `--leave` manufacturing a hand-back for a session that never happened is
 *    exactly that comparison.
 *  - `collectRunReport` puts `voided` straight into the run report. That array
 *    is the list of guarantees a person's keystrokes invalidated, so an
 *    unvalidated one is a report asserting which grades to distrust on the
 *    strength of whatever was in the file.
 *
 * The two-step shape exists ONLY to keep the diagnoses apart — bad JSON, wrong
 * build, wrong shape are three different sentences — not to leave anything
 * unchecked.
 *
 * The stamp is read BEFORE the schema, for the reason `control-auth.ts` gives:
 * a future `v2` that renames a field fails on that field, and zod reports
 * whichever issue it reaches first, so a stamp check running second would
 * diagnose a version skew as a missing `entered_at`.
 */
export async function readAttended(
  run: RunPaths,
  workerId: string,
): Promise<AttendedRecord | null> {
  const path = workerPaths(run, workerId).attendedJson;
  const file = Bun.file(path);
  if (!(await file.exists())) return null;

  let doc: unknown;
  try {
    doc = JSON.parse(await file.text());
  } catch (err) {
    throw new StateReadError(path, err);
  }

  const stamp = (doc as { schema?: unknown } | null)?.schema;
  if (stamp !== ATTENDED_SCHEMA) {
    throw new AttendedSchemaError(
      path,
      typeof stamp === "string"
        ? JSON.stringify(stamp)
        : stamp === undefined
          ? "<no schema field>"
          : String(stamp),
    );
  }

  try {
    return AttendedRecordSchema.parse(doc);
  } catch (err) {
    throw new StateReadError(path, err);
  }
}

async function writeAttended(
  run: RunPaths,
  workerId: string,
  record: AttendedRecord,
): Promise<void> {
  await writeJsonAtomic(
    workerPaths(run, workerId).attendedJson,
    AttendedRecordSchema.parse(record),
  );
}

export interface ModeSwitchArgs {
  run: RunPaths;
  workerId: string;
  backend: PaneDriver;
  pane: PaneRef;
}

/**
 * Hand the pane to a person. Returns the record as written.
 *
 * Re-entering after a `--leave` keeps the ORIGINAL `entered_at` — the record
 * answers "was this run ever touched", and the first touch is when the answer
 * became yes — while `left_at` returns to `null` and the voided table is
 * refreshed to the current build's list.
 */
export async function enterTui(args: ModeSwitchArgs): Promise<AttendedRecord> {
  const existing = await readAttended(args.run, args.workerId);
  const record: AttendedRecord = AttendedRecordSchema.parse({
    schema: ATTENDED_SCHEMA,
    worker: args.workerId,
    mode: "tui" satisfies PaneMode,
    entered_at: existing?.entered_at ?? new Date().toISOString(),
    left_at: null,
    voided: [...TUI_VOIDED],
  });

  // Record first, pane second — see the module comment for why this order.
  await writeAttended(args.run, args.workerId, record);
  await args.backend.attachViewer(
    args.pane,
    interactiveArgv(args.run.runId, args.workerId),
  );
  return record;
}

/**
 * Hand the pane back. Returns the record as updated. The file survives:
 * `left_at` is set, nothing is removed.
 */
export async function leaveTui(
  args: ModeSwitchArgs & { runsRoot: string },
): Promise<AttendedRecord> {
  const existing = await readAttended(args.run, args.workerId);
  /**
   * `mode === "tui"`, not merely "a record exists".
   *
   * `steer` writes an attended record too — a steer IS a human reaching into
   * a run — with `mode: "viewer"`, because no pane was ever handed over. The
   * guard tested only for null, so after any steer, `tui --leave` on a worker
   * whose pane was never taken succeeded: it respawned the viewer and stamped
   * a fresh `left_at`, manufacturing a hand-back for a session that never
   * happened. The record is meant to describe what occurred, so it must not
   * be possible to write an ending to something that had no beginning.
   */
  if (existing === null || existing.mode !== "tui") {
    throw new AttendedModeError(
      `worker ${args.workerId} does not have a pane handed to a person in this run; nothing to leave`,
    );
  }

  // Pane first, record second — see the module comment for why this order.
  await args.backend.attachViewer(
    args.pane,
    viewerArgv(args.runsRoot, args.run.runId, args.workerId),
  );
  const record: AttendedRecord = AttendedRecordSchema.parse({
    ...existing,
    mode: "viewer" satisfies PaneMode,
    left_at: new Date().toISOString(),
  });
  /**
   * Updated in place, never removed. `left_at` is the whole difference
   * between "a person is typing here now" and "a person typed here", and
   * only the second one is a fact about the RUN. Deleting the record on
   * leave would let an attended run present as unattended the moment the
   * operator handed the pane back — which is the one outcome this subsystem
   * exists to prevent.
   */
  await writeAttended(args.run, args.workerId, record);
  return record;
}
