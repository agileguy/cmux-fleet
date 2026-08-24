/**
 * Reading a process group from the OS (ISC-272). One implementation, shared by
 * the WRITER of every launch record and the READER that vouches for it.
 *
 * THIS MODULE IMPORTS NOTHING, and that is the reason it exists as a file
 * rather than as a section of `kill.ts`. `kill.ts` sits on the documented
 * `kill.ts -> run/registry.ts -> … -> safety/reaper.ts -> kill.ts`
 * initialisation cycle, so `supervisor/launch.ts` could not import from it
 * without adding a second, wider arc to that cycle. The previous answer to
 * that constraint was to keep a SECOND `ps -o pgid=` reader in
 * `supervisor/launch.ts` and to write the duplication down as deliberate —
 * which left the strict reader vouching for a number the lax writer produced.
 * `stall.ts` set the precedent: a dependency-free module cannot participate in
 * a cycle, so it can be imported from anywhere, and the duplication is
 * unnecessary rather than unavoidable.
 *
 * WHY THE WRITER AND THE READER MUST AGREE. `down` refuses to signal a group
 * unless the launch record agrees with the OS and the identity-validated
 * supervisor leads it. Every one of those checks compares a number this module
 * produced against a number this module produced. A writer that answers
 * "affirmatively no such process" where the reader would answer "I could not
 * find out" does not make the comparison fail safe — it makes the two sides
 * disagree about what was even measured, and the launch record then carries a
 * fact nobody established.
 */

/**
 * A `ps` read of a process group that did not produce a group, for a reason
 * OTHER than the process being gone (ISC-272).
 *
 * "The process is not there" and "I could not find out" are different facts
 * with opposite safe answers, and `processGroupId` used to return `null` for
 * both. `confirmGroup` mapped that `null` to `gone`, and `down` maps `gone` to
 * the ONE anchor verdict that reports `stopped: true`, calls `reapContainer()`
 * and makes the worker prunable. So a transient `ps` failure against a LIVE
 * supervisor reported it stopped, force-removed its container, and let
 * `--prune` delete the checkout it was still writing to. Unknown IDENTITY
 * already refused; unknown GROUP-because-the-read-failed declared success and
 * deleted.
 *
 * Thrown rather than returned so the two facts cannot be conflated again by a
 * caller that forgets to look: there is no in-band value to ignore.
 */
export class GroupReadError extends Error {
  constructor(pid: number, detail: string) {
    super(`could not read the process group of pid ${pid}: ${detail}`);
    this.name = "GroupReadError";
  }
}

/** The `ps` spawn, factored out ONLY so `proc`'s type can be named below. */
function spawnGroupPs(pid: number) {
  return Bun.spawn(["ps", "-o", "pgid=", "-p", String(pid)], {
    env: { ...process.env, LC_ALL: "C" },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * The live process group of a pid, from `ps`. `null` means `ps` AFFIRMATIVELY
 * reported no such process; a read that failed for any other reason throws
 * `GroupReadError`.
 *
 * `LC_ALL=C` for the same class of reason `processStartTime` pins its
 * environment, though the stakes are far lower: this field is an integer, not
 * a rendered timestamp. Pinning it costs nothing and removes the question.
 *
 * WHAT "AFFIRMATIVELY GONE" LOOKS LIKE, measured on this machine (Darwin 25.5,
 * the base-system `ps`) rather than assumed. Same five readings twice:
 *
 *   pid 999998, above the pid ceiling  exit 1  stdout ""       stderr "ps: process id too large: 999998"
 *   a live pid                         exit 0  stdout "15391"  stderr ""
 *   `-p not-a-number`                  exit 1  stdout ""       stderr "ps: Invalid process id: not-a-number"
 *   an unknown flag                    exit 1  stdout ""       stderr "ps: illegal option -- -"
 *   a pid that exited and was reaped   exit 1  stdout ""       stderr ""
 *
 * THE EXIT CODE IS NOT THE DISCRIMINATOR, which is the whole reason this was
 * worth measuring instead of reasoning about: a reaped pid and a malformed
 * invocation are byte-identical on exit status AND on stdout. The one thing
 * that separates them is that a genuinely-absent process is the case where `ps`
 * says NOTHING — no output and no diagnostic. So stderr is captured rather than
 * ignored, and silence on all three channels is what `null` means.
 *
 * Linux `procps` was NOT probed: no image in this checkout carries `ps`, and
 * CI's runner was not available to measure. It does not have to be. A platform
 * whose `ps` writes a diagnostic for an absent pid degrades to `read_failed`,
 * which REFUSES — the cost is a dead supervisor's container outliving it until
 * a later scan, never a live supervisor's container being destroyed.
 * `confirmGroup`'s identity re-check covers the opposite direction.
 *
 * A pgid is only ever COMPARED, never trusted on its own — see `confirmGroup`.
 */
export async function processGroupId(pid: number): Promise<number | null> {
  /*
   * THE SPAWN ITSELF CAN THROW, and that is the likeliest real instance of
   * "the measuring instrument is broken": a minimal container image with no
   * procps. `Bun.spawn` raises `Error: Executable not found in $PATH: "ps"`
   * synchronously, with no `exitCode` — so without this wrapper the entry
   * point reports `EXIT.INTERNAL`, "a bug in pifleet itself", for an
   * environment failure. `down.ts` already wraps its `docker` spawn for
   * exactly this reason.
   */
  let proc: ReturnType<typeof spawnGroupPs>;
  try {
    proc = spawnGroupPs(pid);
  } catch (err) {
    throw new GroupReadError(pid, `ps could not be started: ${String(err)}`);
  }
  // Both pipes concurrently. Draining one to EOF while the other fills its
  // buffer is how a tiny read becomes a deadlock on the day `ps` gets chatty.
  const [rawOut, rawErr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const out = rawOut.trim();
  const err = rawErr.trim();
  await proc.exited;

  if (proc.exitCode !== 0) {
    /*
     * A SIGNAL-KILLED `ps` IS NOT AN ABSENT PROCESS, and it looks exactly like
     * one on every channel this function reads. Measured on bun 1.3.11: a child
     * terminated by a signal reports `exitCode: null`, `signalCode: "SIGKILL"`,
     * and empty stdout AND stderr — so `exitCode !== 0` is true, both pipes are
     * silent, and the pre-fix condition below answered "affirmatively gone".
     *
     * That is the destructive answer. `gone` is the one verdict `down` may
     * report as a stop, act on with `docker rm -f`, and pass to the `--prune`
     * gate as prunable, so a `ps` killed by memory pressure, an OOM killer, a
     * cgroup limit or a stray `pkill` would have deleted the checkout of a
     * supervisor that was alive and mid-write.
     *
     * Worse, it defeats the identity re-check guard on ITS OWN stated threat
     * model: that guard exists because "the conditions that break one `ps` are
     * exactly the conditions that break the other", and under exactly that
     * pressure BOTH children are signal-killed, both read as absent, and the
     * guard concludes `gone` — the outcome it was built to prevent.
     *
     * So absence requires a NORMAL exit. `exitCode === null` means the child
     * never got to say anything about the process, which is the definition of
     * a failed read.
     */
    if (proc.exitCode !== null && out.length === 0 && err.length === 0) return null;
    throw new GroupReadError(
      pid,
      err.length > 0
        ? err
        : proc.signalCode !== null
          ? `ps was killed by ${proc.signalCode} before it could answer`
          : `ps exited ${String(proc.exitCode)} without saying why`,
    );
  }
  const pgid = Number.parseInt(out, 10);
  if (!Number.isInteger(pgid) || pgid <= 0) {
    // Exit 0 with nothing usable on stdout. `ps` claimed success and told us
    // nothing, which is a broken read and emphatically not "no such process".
    throw new GroupReadError(pid, `ps printed ${JSON.stringify(out)}, which is not a process group`);
  }
  return pgid;
}
