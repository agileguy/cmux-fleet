/**
 * Detached supervisor launching (SRD §3.3, §11) and the control-socket client.
 *
 * The supervisor is detached from whatever launched it — CLI, pane shell,
 * test runner — via `Bun.spawn({detached: true})` + `unref()`, which makes it
 * a process-group leader in its own session. Tying a control-plane process's
 * lifetime to a pane means closing a pane — a cosmetic act — orphans a
 * container that still holds a worktree and still spends money. Concretely:
 * closing a pane must not stop the worker (ISC-74), killing the CLI mid-run
 * must leave supervisors running (ISC-75), and `pgid == pid` with a session
 * distinct from the launcher's is the observable proof (ISC-77/78).
 *
 * This is a `SupervisorLauncher`, deliberately NOT a `FleetBackend` method:
 * spawning a supervisor is not spawning into a pane, and v1.1's conflation of
 * the two made the supervisor a pane child by construction.
 */

import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { LaunchRecord, SupervisorLauncher, WorkerSpec } from "../backends/types.ts";
import { processStartTime, socketRequest } from "../run/registry.ts";
import { processGroupId } from "../safety/procgroup.ts";
import { loadControlSecret } from "../security/control-auth.ts";
import { workerPaths, type RunPaths } from "../run/paths.ts";

/** Absolute path to the supervisor entrypoint, wherever this checkout lives. */
export function supervisorEntrypoint(): string {
  return new URL("./index.ts", import.meta.url).pathname;
}

/** Build the argv `up` hands to the launcher — also what `render` would show. */
export function supervisorArgv(opts: {
  runsRoot: string;
  runId: string;
  workerId: string;
}): string[] {
  return [
    process.execPath, // the running bun binary, not whatever is on PATH
    supervisorEntrypoint(),
    "--runs-root",
    opts.runsRoot,
    "--run",
    opts.runId,
    "--worker",
    opts.workerId,
  ];
}

/**
 * The capture-failed launch record. Both fields are sentinels every reader
 * already refuses: `confirmGroup` rejects a non-positive group as
 * `unrecorded`, and `down`'s `anchorIdentity` maps `""` to
 * `identity_unrecorded` — refusals, not degradations to a weaker anchor.
 *
 * `-1` rather than `0` so a launcher that could not measure is distinguishable
 * on disk from a SUPERVISOR that could not measure its own group
 * (`supervisor/index.ts` records `0`). Both refuse; they send an operator to
 * different logs.
 */
const UNRECORDED: LaunchRecord = { pid: -1, pgid: -1, started: "" };

/**
 * Spawn a detached supervisor and RECORD ITS IDENTITY AT LAUNCH (ISC-191,
 * ISC-272).
 *
 * ## Why the record is written here and nowhere else
 *
 * `up.ts` used to take the pid this returns and read the start time off it
 * itself — `identities.set(workerId, { pid, started: (await
 * processStartTime(pid)) ?? "" })` — and `registry.ts`'s own docstring called
 * that capture site "weaker than the other two", on the grounds that the pid
 * "can be reaped between launch and read" and the consequence would be the
 * `""` sentinel.
 *
 * THAT IS NOT THE CONSEQUENCE, and the gap is the whole reason this function
 * changed. `""` is what you get when the pid is reaped and left IDLE. If the
 * kernel has reissued it — which is what a busy machine does with a pid the
 * moment its parent reaps it — then `processStartTime(pid)` returns a
 * STRANGER'S start time, and `pgidOf(pid)` returned a stranger's group. Both
 * reads succeed. The pair they produce is internally consistent, agrees with
 * the OS at every later rung, and names a process this run never launched. So
 * `down` would climb its whole ladder in perfect good faith — `anchorIdentity`
 * agreeing, `sameIdentity` agreeing at every rung, `confirmGroup` confirming a
 * group the stranger really does lead — and SIGKILL that group. Every guard
 * ISC-191 and ISC-272 installed downstream compares the record against the OS;
 * none of them can catch a record that was WRITTEN from the OS in the first
 * place. A start time read off a live pid is the thing ISC-272 forbids at rung
 * 0, and moving it to launch time narrows the window without changing what it
 * is.
 *
 * ## What makes this a launch record rather than another read off a live pid
 *
 * This function is the only place in the codebase that holds the child HANDLE,
 * and the handle is what turns a read into a record. POSIX retains a child's
 * pid until its parent reaps it — that is what a zombie IS — so while
 * `proc.exitCode` and `proc.signalCode` are both still `null`, the kernel
 * cannot have reissued `proc.pid` to anybody. The reads above therefore
 * describe the process this function spawned, and not merely whatever holds
 * the number.
 *
 * The check runs AFTER the reads, and the ordering is load-bearing rather than
 * incidental: "not reaped now" implies "not reaped at any earlier instant", so
 * a check that passes afterwards vouches for reads taken before it. The
 * reverse order would vouch for nothing. If the child is reaped inside the
 * window, the check fails and the record is discarded — the safe direction,
 * and the only one this ordering can produce.
 *
 * `pgid === proc.pid` is the second condition and it is not redundant. Every
 * supervisor is spawned `detached`, so it leads its own group; this file's
 * header has stated `pgid == pid` as ISC-77/78's observable proof since it was
 * written, and it was never once checked at the moment it was relied upon. A
 * reading that disagrees is either a `ps` that answered about someone else or
 * a detach that did not take, and in both cases the number is not this
 * supervisor's group.
 *
 * ## What a failed capture costs
 *
 * A refused capture yields `UNRECORDED`, and a worker whose launch record is
 * unrecorded cannot be stopped by a bare `pifleet down` — it refuses rather
 * than anchoring on whatever holds the pid, and `--force-identity` is the
 * named hatch. That is deliberately the expensive direction. The alternative
 * is a record that cannot be told apart from a good one, which is how a
 * stranger's process group gets SIGKILLed with every guard reporting success.
 */
export const processLauncher: SupervisorLauncher = {
  async launchDetached(spec: WorkerSpec): Promise<LaunchRecord> {
    await mkdir(dirname(spec.logPath), { recursive: true });
    // Append, never truncate: a relaunch must not erase the previous
    // incarnation's dying words.
    const log = openSync(spec.logPath, "a");

    const proc = Bun.spawn({
      cmd: spec.argv,
      env: { ...process.env, ...spec.env },
      detached: true,
      stdin: "ignore",
      stdout: log,
      stderr: log,
    });
    // unref: the launcher must be free to exit while the supervisor lives on.
    proc.unref();

    /*
     * A THROWN read is a failed capture, never an absent process. Both readers
     * refuse rather than reporting absence when `ps` cannot be read
     * (`GroupReadError`, `IdentityReadError`), and a launcher has nothing
     * useful to do with that distinction: it did not measure the thing, so it
     * records that it did not measure the thing. `null` from `processGroupId`
     * ("affirmatively no such process") lands in the same place — a supervisor
     * that is already gone has no identity worth recording.
     */
    const pgid = await processGroupId(proc.pid).catch(() => null);
    const started = await processStartTime(proc.pid).catch(() => null);

    // See the header: this is what makes the two reads above a RECORD.
    const stillOurs = proc.exitCode === null && proc.signalCode === null;
    if (!stillOurs || pgid === null || started === null || pgid !== proc.pid) {
      return { ...UNRECORDED, pid: proc.pid };
    }
    return { pid: proc.pid, pgid, started };
  },
};

// ---------------------------------------------------------------------------
// Control-socket client — how the CLI talks to a live supervisor.
// ---------------------------------------------------------------------------

/**
 * One request/response against a worker's control socket.
 *
 * Loads the run's control secret (SRD §12.7) and lets the transport stamp it;
 * a run with no auth record fails here with a `ControlAuthError` that names
 * the missing file, which beats a refusal from the far end that cannot say
 * WHY the caller has no token.
 */
export async function controlCall(
  run: RunPaths,
  workerId: string,
  msg: Record<string, unknown>,
  opts: { timeoutMs?: number } = {},
): Promise<Record<string, unknown>> {
  const wp = workerPaths(run, workerId);
  const secret = await loadControlSecret(run);
  return socketRequest(wp.controlSock, msg, { ...opts, secret });
}
