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

export const realExec: Exec = async (argv, opts = {}) => {
  const proc = Bun.spawn(argv, {
    cwd: opts.cwd,
    env: opts.env ? { ...process.env, ...opts.env } : process.env,
    stdin: opts.stdin !== undefined ? new TextEncoder().encode(opts.stdin) : undefined,
    stdout: "pipe",
    stderr: "pipe",
  });

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
