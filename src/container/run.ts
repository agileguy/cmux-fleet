/**
 * Process execution helpers for everything that shells out to `docker`.
 *
 * One spawn wrapper, injectable everywhere it is consumed, so unit tests can
 * substitute a recorder and the integration suite can use the real thing. The
 * wrapper never throws on a non-zero exit — callers decide what an exit code
 * means, because for probes (image verify, doctor) a failure IS the datum.
 */

import { join } from "node:path";

export interface ExecResult {
  /** null when the process was killed by the timeout. */
  code: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

export interface ExecOptions {
  timeoutMs?: number;
  cwd?: string;
  env?: Record<string, string>;
  stdin?: string;
}

export type Exec = (argv: string[], opts?: ExecOptions) => Promise<ExecResult>;

/** Default probe timeout. Generous because `docker run` cold-starts a VM path on macOS. */
const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * How long a process gets to honour SIGTERM before SIGKILL.
 *
 * The timeout used to send SIGTERM and nothing else, so a process that traps
 * or ignores it outlived its own deadline forever. SIGKILL cannot be trapped,
 * which is the only reason `proc.exited` is guaranteed to settle.
 */
const KILL_GRACE_MS = 2_000;

/**
 * How long the pipes get to finish AFTER the process has exited.
 *
 * A child that spawns a grandchild and exits leaves the grandchild holding
 * the write end of the pipe, so the read never ends even though the process
 * this function waited on is long gone. The bound turns that from a hang into
 * whatever output arrived, which is what a caller can actually use.
 */
const DRAIN_MS = 2_000;

/**
 * Read a stream to text, abandoning it if `giveUp` settles first.
 *
 * Chunks are accumulated as they arrive rather than awaited in one go, so
 * giving up early still returns everything that was received. `Response.text()`
 * cannot do that: abandoning it discards the output entirely.
 */
async function pump(
  stream: ReadableStream<Uint8Array> | null | undefined,
  giveUp: Promise<void>,
): Promise<string> {
  if (stream === null || stream === undefined) return "";
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  void giveUp.then(() => reader.cancel().catch(() => {}));
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value !== undefined) chunks.push(value);
    }
  } catch {
    // Cancelled by `giveUp`, or the pipe broke. Either way, what arrived
    // before that point is still the honest answer.
  }
  let size = 0;
  for (const c of chunks) size += c.length;
  const joined = new Uint8Array(size);
  let at = 0;
  for (const c of chunks) {
    joined.set(c, at);
    at += c.length;
  }
  return new TextDecoder().decode(joined);
}

/**
 * POSIX's "command not found". Returned instead of throwing when the
 * executable is absent, so absence reaches callers as a datum.
 */
export const EXEC_NOT_FOUND = 127;

export const realExec: Exec = async (argv, opts = {}) => {
  let proc;
  try {
    proc = Bun.spawn(argv, {
      cwd: opts.cwd,
      env: opts.env ? { ...process.env, ...opts.env } : process.env,
      stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : undefined,
      stdout: "pipe",
      stderr: "pipe",
    });
  } catch (err) {
    /**
     * `Bun.spawn` THROWS when the executable is not in `$PATH` — it does not
     * return 127 the way a shell does. The header above promises callers that
     * a failure is a datum rather than an exception, and `dockerAvailable`
     * below states outright that "absence is a report, not an exception";
     * both were true for a tool that runs and fails, and false for a tool
     * that is not installed.
     *
     * `doctor` is where that mattered most: the command whose entire purpose
     * is reporting which tools are missing died with an uncaught spawn error
     * and exit 2 the moment one actually was. It reported nothing at all —
     * no JSON, no diagnosis — on precisely the machine that needed the
     * report. CI, which has no `pi` installed, is where it surfaced.
     *
     * EVERY spawn failure converts, not just a missing executable, and the
     * errno is why. Probing showed `ENOENT` covers both a missing binary and
     * a missing `cwd`, while a present-but-unexecutable file raises `EACCES`
     * — so the code cannot separate "not installed" from "installed and
     * unusable" anyway. Both are things `doctor` exists to say out loud, and
     * narrowing this to one errno would only move the crash to the next one.
     * The distinction that matters survives in `stderr`, which carries Bun's
     * own message verbatim.
     */
    return {
      code: EXEC_NOT_FOUND,
      stdout: "",
      stderr: err instanceof Error ? err.message : String(err),
      timedOut: false,
    };
  }

  /**
   * The timeout has to actually end the call, and the original could not.
   *
   * It sent SIGTERM once and then `Promise.all`-ed the two pipe reads with
   * `proc.exited`, so two ordinary inputs hung `realExec` forever — measured,
   * not theorised:
   *
   *   sh -c "trap '' TERM; sleep 10"     never resolved (SIGTERM ignored)
   *   sh -c "sleep 30 & echo parent-done" never resolved (grandchild holds pipe)
   *
   * Every backend call passes `timeoutMs: 15_000` and would have waited
   * forever on either, so `up` hangs rather than losing a pane. Two changes
   * fix it: escalate to SIGKILL, which cannot be trapped, so `proc.exited`
   * always settles; and stop treating the pipe reads as part of that wait,
   * because a pipe can outlive the process holding the other end.
   *
   * The pumps still START before the wait. A process emitting more than the
   * pipe buffer blocks on write until someone reads, so deferring the reads
   * until after exit would deadlock exactly the large-output case this is
   * meant to survive — 8MB of stdout drains fine precisely because both
   * pipes are being drained concurrently throughout.
   */
  let timedOut = false;
  let giveUp!: () => void;
  const giveUpPromise = new Promise<void>((resolve) => {
    giveUp = resolve;
  });
  const stdoutP = pump(proc.stdout as ReadableStream<Uint8Array> | null, giveUpPromise);
  const stderrP = pump(proc.stderr as ReadableStream<Uint8Array> | null, giveUpPromise);

  let killTimer: ReturnType<typeof setTimeout> | undefined;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
    killTimer = setTimeout(() => proc.kill("SIGKILL"), KILL_GRACE_MS);
    killTimer.unref?.();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  timer.unref?.();

  try {
    const code = await proc.exited;
    // The process is gone; anything still holding the pipes is not it.
    const drain = setTimeout(giveUp, DRAIN_MS);
    drain.unref?.();
    const [stdout, stderr] = await Promise.all([stdoutP, stderrP]);
    clearTimeout(drain);
    return { code: timedOut ? null : code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
    if (killTimer !== undefined) clearTimeout(killTimer);
    giveUp();
  }
};

/** True when a Docker daemon answers. Absence is a report, not an exception. */
export async function dockerAvailable(exec: Exec = realExec): Promise<boolean> {
  const r = await exec(["docker", "info", "--format", "{{.ServerVersion}}"], {
    timeoutMs: 10_000,
  });
  return r.code === 0;
}

/**
 * Repository root, resolved from this module's location rather than cwd —
 * a CLI invoked from any directory must still find `docker/Dockerfile`.
 */
export function repoRoot(): string {
  return join(import.meta.dir, "..", "..");
}
