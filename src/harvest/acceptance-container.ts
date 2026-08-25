/**
 * The exam's container (SRD §8.2, ISC-233) — a fresh container from the same
 * image, per acceptance command.
 *
 * `acceptance.ts` already grades from a fresh CLONE, which defeats every
 * attack that lives in the worker's files: no dirty tree, no `.git/hooks`, no
 * pre-seeded `node_modules`. What a clone cannot defeat is everything that
 * lives OUTSIDE the tree. The worker ran in a container; the harvester runs on
 * the operator's laptop. So a suite that passes because the operator happens to
 * have a newer node, a global `pytest` plugin, a `~/.npmrc` registry override
 * or a tool the image does not ship passes for a reason that has nothing to do
 * with the code — and the reverse, a suite that fails on the operator's machine
 * for a missing binary, reads as the worker's fault. §8.2's contrast clause
 * ("not only a fresh clone") is about that half.
 *
 * ## Why this is a separate module
 *
 * `AcceptanceContext.image` existed for a year as the literal `null`, and the
 * audit that filed ISC-233 measured that mutating it to a plausible tag —
 * an audit record claiming a container that never ran — left 104 tests green.
 * A builder nothing calls, in a file nothing imports, is the exact shape that
 * hid. Kept separate and exported so `grep` for its name answers "is this
 * wired?" in one command, the way `feedback_agents_stall_at_mutation_proofs`
 * says the acceptance test for "a thing that runs" has to.
 *
 * ## What is deliberately NOT re-derived here
 *
 * The hardening flags mirror `config/render.ts`'s worker posture (§5.6) rather
 * than inventing a second one: same uid, same `--cap-drop ALL`, same
 * `no-new-privileges`, same read-only root with a `noexec` `/tmp`. The exam
 * should not run under a WEAKER posture than the work it grades — a suite that
 * only passes with capabilities the worker never had is not evidence about the
 * worker.
 */

import { WORKER_UID } from "../container/mounts.ts";

/**
 * Where the fresh clone is mounted. Fixed, not arbitrary, and this is why.
 *
 * `docker/Dockerfile` bakes `git config --system --add safe.directory
 * /workspace` at build time, as root. That entry is what lets uid 10001 run
 * git inside a bind mount the host's uid owns — the CVE-2022-24765 ownership
 * refusal ISC-298 spent a whole PR discovering keys on OWNERSHIP and ignores
 * mode, so no amount of `chmod` substitutes for it. The baked entry names this
 * path literally. Mounting the clone anywhere else silently loses it, and
 * every acceptance command that shells out to git — a version test running
 * `git describe`, a snapshot test that diffs against HEAD — fails with
 * `detected dubious ownership`.
 *
 * MEASURED 2026-08-25 on this machine (Colima, Docker 28.4.0), against the
 * real `pifleet/pi-worker:verify` and a real scratch clone, because the first
 * draft of this comment guessed and guessed wrong. It claimed the failure was
 * Linux-only and hidden on macOS by the VM's ownership squash. It is not
 * hidden: `stat -c '%u:%g %a' /workspace` inside the container reports
 * `0:0 777`, so the mount presents as ROOT-owned to a process running as
 * 10001 and git's ownership check fires here exactly as it would on a runner.
 * The two arms, one flag apart:
 *
 *   --entrypoint git ... status --porcelain      -> exit 0, clean output
 *   ... plus -e GIT_CONFIG_SYSTEM=/dev/null      -> fatal: detected dubious
 *                                                   ownership in repository
 *
 * That second line is the HOST path's environment applied here unchanged, and
 * it is why `acceptanceContainerEnv` departs from `buildEnv` rather than
 * reusing it.
 */
export const ACCEPTANCE_WORKDIR = "/workspace";

export interface AcceptanceContainerSpec {
  /** The image the worker itself ran, from its `launch.json`. */
  image: string;
  /** Host path of the fresh clone; bind-mounted read-WRITE at `/workspace`. */
  cloneDir: string;
  /** The tokenized acceptance command. `argv[0]` becomes the entrypoint. */
  argv: readonly string[];
  /**
   * `--name`, so a container that outlives its budget can still be reaped.
   *
   * `--rm` is NOT sufficient and the repository already knows why: it is a
   * CLIENT-side action, so killing the client — which is exactly what a
   * timeout does — leaves the container running with nothing left to remove
   * it. `container-launch.test.ts` makes the same point about the supervisor's
   * kill ladder and `down`. A name is what lets the timeout path issue
   * `docker rm -f` against a specific container rather than guessing.
   *
   * This was found by this feature's OWN test: the `timed_out` probe left a
   * `sleep 60` container running after the run it belonged to had been
   * recorded and returned. A real acceptance suite is not a 60-second sleep.
   */
  containerName: string;
  /** Environment for the command, as `-e K=V`. Never a pass-through (ISC-31). */
  env: Readonly<Record<string, string>>;
  /**
   * The network the WORKER ran on, read back out of its launch argv, or `null`
   * to take the daemon's default.
   *
   * Taken from the recorded bytes rather than recomputed from config, for the
   * reason `up`'s image gate gives about `renderAllWorkers`: a value that is
   * derived twice can disagree with itself, and here that would mean grading
   * on a network the worker never had. `pifleet-egress` — the schema default —
   * is a relay-confined bridge, so a `bridge`-defaulted exam would hand the
   * acceptance commands MORE egress than the code under examination ever got.
   *
   * The cost is stated rather than hidden: a run whose network has since been
   * removed (`down --prune`) makes `docker run` fail, which surfaces as
   * `not_run` and adjudicates to `unknown`. That is the honest outcome — an
   * exam that cannot be reproduced is not an exam that was passed — and it is
   * strictly better than silently re-running it somewhere else.
   */
  network?: string | null;
}

/**
 * The `--network` value out of a recorded launch argv, or `null` if it has none.
 *
 * Reads the argv the run ACTUALLY used rather than re-deriving from config,
 * which is the same rule `harvest/patterns.ts` states for the harness surface:
 * the harvester is handed a run directory, and a run outlives the config that
 * produced it.
 */
export function networkFromLaunchArgv(argv: readonly string[]): string | null {
  for (let i = 0; i < argv.length - 1; i += 1) {
    if (argv[i] === "--network" || argv[i] === "--net") return argv[i + 1] ?? null;
  }
  return null;
}

/**
 * A per-command container name, unique within a run and recognisable in `docker ps`.
 *
 * The `pifleet-accept-` prefix is the part that matters operationally: an
 * operator looking at a stuck daemon can tell an exam container from a worker
 * (`pifleet-<run>-<worker>`) at a glance, and can sweep them by prefix.
 */
export function acceptanceContainerName(headSha: string, nonce: string, index: number): string {
  return `pifleet-accept-${headSha.slice(0, 12)}-${nonce}-${index}`;
}

/**
 * Remove a container that outlived its budget, by name.
 *
 * Best-effort and deliberately silent: by the time this runs the acceptance
 * result is already decided (`timed_out`), and a reaper that threw would
 * replace a real verdict with its own cleanup failure. A container that
 * already exited leaves `docker rm -f` with nothing to do and a non-zero exit,
 * which is not an error worth surfacing either.
 */
export async function reapAcceptanceContainer(
  name: string,
  env: Record<string, string>,
): Promise<void> {
  try {
    const p = Bun.spawn(["docker", "rm", "-f", name], {
      env,
      stdin: "ignore",
      stdout: "ignore",
      stderr: "ignore",
    });
    await p.exited;
  } catch {
    // No docker on PATH at all. Nothing to reap and nothing to say.
  }
}

/**
 * Environment for an acceptance command running INSIDE the image.
 *
 * Deliberately not `buildEnv`'s output, and the differences are each load-
 * bearing rather than stylistic:
 *
 *  - **No `PATH`.** The image's own `PATH` is the one its toolchain was built
 *    against. Injecting the host's (`/opt/homebrew/bin`, ...) would name
 *    directories that do not exist in the container and shadow the ones that
 *    do — the fastest way to turn "the image ships node 22" into "command not
 *    found".
 *
 *  - **`HOME=/tmp`, not the scratch root.** The host path points `HOME` at
 *    scratch because a real suite writes caches and tool state somewhere, and
 *    that must be outside the graded tree. Inside the container the baked
 *    `HOME=/home/pi` sits on the read-only root, so a suite writing there gets
 *    `EROFS`; `/tmp` is the tmpfs mounted below and is the only writable path
 *    that is not the tree under examination.
 *
 *  - **`GIT_CONFIG_SYSTEM` is NOT set.** The host path blanks it, correctly:
 *    on a laptop `/etc/gitconfig` is operator state and grading through it is
 *    grading through the environment. In the image it is the opposite — a
 *    build-time artifact containing exactly one line, the `safe.directory`
 *    entry documented above — so blanking it here REINSTATES the ownership
 *    refusal this whole path exists on the far side of. Not "would": that is
 *    the measured second arm in `ACCEPTANCE_WORKDIR`'s comment, run against the
 *    real image. Blanking `GIT_CONFIG_GLOBAL` is still right and is still done:
 *    `HOME` is a tmpfs, so there is nothing there, and saying so costs nothing.
 */
export function acceptanceContainerEnv(): Record<string, string> {
  return {
    HOME: "/tmp",
    LC_ALL: "C",
    TERM: "dumb",
    CI: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
  };
}

/**
 * Build the `docker run` argv for ONE acceptance command.
 *
 * `--entrypoint` is the piece that needs stating. The image's entrypoint is
 * `tini -- pifleet-entrypoint`, a wrapper that renders Pi's model config and
 * exec's the agent; running an acceptance command through it would start a Pi
 * session, not a test suite. Overriding it with `argv[0]` and passing the rest
 * as the container's command runs the command directly, as argv, with no shell
 * anywhere in the path — the same no-expansion-surface property the host path
 * gets from spawning an argv array.
 */
export function acceptanceContainerArgv(spec: AcceptanceContainerSpec): string[] {
  if (spec.argv.length === 0) throw new Error("acceptanceContainerArgv: empty command argv");
  if (spec.image.length === 0) throw new Error("acceptanceContainerArgv: empty image");

  if (spec.containerName.length === 0) {
    throw new Error("acceptanceContainerArgv: empty container name");
  }

  const argv: string[] = ["docker", "run", "--rm"];
  argv.push("--name", spec.containerName);
  argv.push("--user", `${WORKER_UID}:${WORKER_UID}`);
  argv.push("--security-opt", "no-new-privileges");
  argv.push("--cap-drop", "ALL");
  argv.push("--read-only");
  // `noexec` is kept, matching the worker (§5.6). A harness that genuinely
  // needs to execute out of /tmp will fail loudly here, which is the right way
  // to learn it — pre-weakening the exam's posture below the work's would mean
  // grading code under permissions it never had.
  argv.push("--tmpfs", "/tmp:rw,noexec,nosuid,size=256m");
  // The ONLY mount. Not the run directory, not the outbox, not the operator's
  // checkout: the exam needs the code and nothing else, and each additional
  // mount is a path by which the worker's own artifacts could reach it.
  argv.push("-v", `${spec.cloneDir}:${ACCEPTANCE_WORKDIR}`);
  argv.push("-w", ACCEPTANCE_WORKDIR);
  if (spec.network !== null && spec.network !== undefined) {
    argv.push("--network", spec.network);
  }
  // `-e K=V`, never `-e K`. The bare form copies the value out of the HOST
  // environment, which is both ISC-31's refusal and ISC-149's ("no inherited
  // environment") — the two criteria happen to forbid the same flag shape.
  for (const [k, v] of Object.entries(spec.env)) {
    argv.push("-e", `${k}=${v}`);
  }
  argv.push("--entrypoint", spec.argv[0]!);
  argv.push(spec.image);
  argv.push(...spec.argv.slice(1));
  return argv;
}
