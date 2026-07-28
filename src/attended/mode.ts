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
 * The worker's container name, as `config/render.ts` builds it for
 * `docker run --name` (SRD §3.4). Duplicated rather than imported because the
 * renderer computes it inline mid-argv and exporting it from there is outside
 * this phase's edit surface — the same consolidation debt ISC-188/ISC-231
 * track for run paths, and the integration suite pins the two spellings
 * against each other through a live `up`.
 */
export function workerContainerName(runId: string, workerId: string): string {
  return `pifleet-${runId}-${workerId}`;
}

/**
 * What the pane runs while a person owns it: an interactive shell inside the
 * worker's container — same workspace, same tools, same (absent) credentials.
 *
 * NOT `docker attach`: the SRD's §3.5 sketch attaches to a TUI-mode Pi, but
 * this fleet launches Pi in RPC mode with the supervisor holding stdin, and
 * attaching a human keyboard to a JSONL protocol stream would corrupt the
 * control plane on the first keystroke. `docker exec` gives the person hands
 * inside the same boundary without touching Pi's pipes, which is what keeps
 * dispatch, abort and harvest working while the pane is attended.
 */
export function interactiveArgv(runId: string, workerId: string): string[] {
  return ["docker", "exec", "-it", workerContainerName(runId, workerId), "bash"];
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

/** Read a worker's attended record; `null` when the run was never attended. */
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
    schema: "pifleet.attended/v1",
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
