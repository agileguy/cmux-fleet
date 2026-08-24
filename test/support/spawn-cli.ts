/**
 * The one way a test starts the pifleet CLI (ISC-296).
 *
 * ## The failure this exists to make impossible
 *
 * Config resolution is `--config <path>` -> `./fleet.yaml` ->
 * `~/.config/pifleet/fleet.yaml` (`src/config/load.ts`). Every CLI-spawning
 * test used to inherit the DEVELOPER'S cwd, so a `fleet.yaml` sitting in the
 * repo root was discovered by tests that never asked for a config — and that
 * file is gitignored, so it exists on laptops and not on runners.
 *
 * The consequence was a suite that behaved differently depending on who ran
 * it. CI was green because the runner lacks the file; a laptop with one saw
 * fifteen failures whose symptoms pointed at product defects that did not
 * exist. **A green build was not evidence the suite was sound — it was
 * evidence the runner lacked the state that breaks it**, and that is the error
 * direction nobody investigates.
 *
 * ## Why the default is the safe value, rather than a required argument
 *
 * A required `cwd` parameter would still let a new test pass `process.cwd()`,
 * and the resulting breakage would again be invisible on CI. So the DEFAULT is
 * a directory guaranteed to hold no config at all: forgetting produces a
 * hermetic spawn, and reaching ambient config takes a deliberate argument.
 * That is the property the criterion asks for — hermetic by construction, not
 * by everyone remembering.
 *
 * Tests that need a config pass `--config`, or point `cwd` at their own rig
 * directory and put a `fleet.yaml` there. Both are explicit, and both are
 * unaffected by whatever the developer happens to have checked out.
 */

import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The CLI entry point, spelled once rather than in 27 test files. */
export const CLI = new URL("../../src/cli/index.ts", import.meta.url).pathname;

export interface CliResult {
  code: number;
  stdout: string;
  stderr: string;
}

export interface SpawnCliOptions {
  /**
   * Where the CLI runs. Defaults to an empty directory with no `fleet.yaml`.
   *
   * Pass a rig's own base directory when the test needs the CLI to discover a
   * config the test itself wrote. Never pass `process.cwd()` — that is the
   * ambient-config trap this module exists to close.
   */
  cwd?: string;
  /** Merged OVER `process.env`, unless `inheritEnv` is false. */
  env?: Record<string, string | undefined>;
  /**
   * Whether the child starts from `process.env`. Default true.
   *
   * Several tests REPLACE `PATH` rather than prepending to it, and that is
   * load-bearing rather than tidy — `down-unreadable-ps.test.ts` says it
   * outright: "a fall-through to the real `ps` would make a failing assertion
   * look like a passing one". A helper that spread `process.env`
   * unconditionally would re-expose the real `docker`, `git`, `tmux` and `ps`
   * to those rigs and turn their isolation into decoration, silently. So the
   * choice is explicit here rather than implied by whether `env` mentions
   * PATH.
   */
  inheritEnv?: boolean;
  /** Written to the child's stdin, then closed. */
  stdin?: string;
}

/**
 * An empty directory, created once per test process and reused.
 *
 * Lazily created so a suite that never spawns the CLI pays nothing, and
 * memoised on the PROMISE rather than the path so concurrent first callers
 * share one directory instead of racing to make two.
 */
let hermeticCwd: Promise<string> | null = null;
export function hermeticCwdPath(): Promise<string> {
  hermeticCwd ??= mkdtemp(join(tmpdir(), "pifleet-hermetic-cwd-"));
  return hermeticCwd;
}

/**
 * Run the CLI as a real subprocess and collect its exit code and streams.
 *
 * A subprocess rather than an in-process call because the exit-code ladder is
 * part of the contract (SRD §10) and only a real process reports it.
 *
 * `spawnCliProcess` is the same spawn without the collection, for the tests
 * that STREAM — `logs --follow` and `tui` read output while the process is
 * still alive, and killing it is the point rather than an error. They get the
 * same hermetic cwd for free, which is why the split lives here rather than
 * each of them keeping a hand-built spawn.
 */
export async function spawnCliProcess(args: readonly string[], opts: SpawnCliOptions = {}) {
  const cwd = opts.cwd ?? (await hermeticCwdPath());
  return Bun.spawn([process.execPath, CLI, ...args], {
    cwd,
    env: opts.inheritEnv === false ? { ...opts.env } : { ...process.env, ...opts.env },
    stdin: opts.stdin === undefined ? "ignore" : new TextEncoder().encode(opts.stdin),
    stdout: "pipe",
    stderr: "pipe",
  });
}

export async function spawnCli(
  args: readonly string[],
  opts: SpawnCliOptions = {},
): Promise<CliResult> {
  const proc = await spawnCliProcess(args, opts);
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  return { code: await proc.exited, stdout, stderr };
}
