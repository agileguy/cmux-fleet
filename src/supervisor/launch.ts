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
import type { SupervisorLauncher, WorkerSpec } from "../backends/types.ts";
import { socketRequest } from "../run/registry.ts";
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

/** `ps` is the ground truth for process-group membership; there is no syscall API. */
export async function pgidOf(pid: number): Promise<number | null> {
  const proc = Bun.spawn(["ps", "-o", "pgid=", "-p", String(pid)], {
    stdout: "pipe",
    stderr: "ignore",
  });
  const out = (await new Response(proc.stdout).text()).trim();
  await proc.exited;
  const pgid = Number.parseInt(out, 10);
  return Number.isFinite(pgid) ? pgid : null;
}

export const processLauncher: SupervisorLauncher = {
  async launchDetached(spec: WorkerSpec): Promise<{ pid: number; pgid: number }> {
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

    const pgid = (await pgidOf(proc.pid)) ?? -1;
    return { pid: proc.pid, pgid };
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
