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

  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    proc.kill();
  }, opts.timeoutMs ?? DEFAULT_TIMEOUT_MS);

  try {
    const [stdout, stderr, code] = await Promise.all([
      new Response(proc.stdout).text(),
      new Response(proc.stderr).text(),
      proc.exited,
    ]);
    return { code: timedOut ? null : code, stdout, stderr, timedOut };
  } finally {
    clearTimeout(timer);
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
