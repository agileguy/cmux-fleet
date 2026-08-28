/**
 * The process START-TIME read, and the identity format it renders.
 *
 * ## Why this is its own module, and why that is not cosmetic
 *
 * It lived in `run/registry.ts`, and `safety/kill.ts` imported it from there
 * to build `realProcessOps`. That import is one arc of the cycle this
 * directory has been dismantling one module at a time:
 *
 *     kill.ts -> run/registry.ts -> ... -> safety/reaper.ts -> kill.ts
 *
 * `kill.ts`'s own header has described that cycle since the reaper landed, and
 * `stall.ts` and `procgroup.ts` were both extracted to break other arcs of it,
 * each with the same reasoning written down: *a dependency-free module cannot
 * participate in a cycle, so it is importable from anywhere.* This arc was the
 * one left, and leaving it was not free.
 *
 * MEASURED, not theorised: before this move, `bun test test/unit/kill.test.ts`
 * — the obvious command for anyone working on the kill ladder — failed outright
 * with `ReferenceError: Cannot access 'realProcessOps' before initialization`
 * at `reaper.ts:137`, 0 pass / 1 error / exit 1. The file's 40-odd probes only
 * ever ran because some EARLIER file in a full-suite run imported the modules
 * in an order that happened to work. CI never noticed, because CI runs the
 * whole suite and never one file. Two of ISC-272's open residuals are recorded
 * as "unreachable and untested"; a module whose test file cannot be run on its
 * own is a large part of why nobody wrote those fixtures.
 *
 * `registry.ts` re-exports every name below, so no existing caller or doc
 * comment has to change address.
 */
import { EXIT } from "../contracts.ts";

/**
 * The rendering `processStartTime` pins, and the tag it stamps on the result.
 *
 * `ps -o lstart=` RENDERS a timestamp; it does not report one. The rendering
 * is read from the calling process's own environment, so the same live pid at
 * the same instant produces different bytes in different shells — measured on
 * one pid, one instant, this machine:
 *
 *   TZ=UTC               "Thu 20 Aug 06:51:33 2026"
 *   TZ=America/Halifax   "Thu 20 Aug 03:51:33 2026"
 *   TZ=Asia/Tokyo        "Thu 20 Aug 15:51:33 2026"
 *   LC_TIME=de_DE.UTF-8  "Do. 20 Aug. 00:51:33 2026"
 *
 * An identity is captured in the LAUNCHER's environment and compared in the
 * OPERATOR's, and those are routinely different processes: `up` from a local
 * terminal and `down` over SSH (sshd forwards `LC_TIME` under its default
 * `AcceptEnv LANG LC_*`), `up` from launchd or cron with no `TZ` at all and
 * `down` from a shell that sets one, a containerised CLI against a
 * host-launched daemon. Every one of those made a LIVE supervisor compare
 * unequal to its own recorded identity — which the whole kill path reads as
 * "this process is gone". DST is not involved; the offset does not have to
 * change for the two renderings to differ.
 *
 * So the rendering is pinned at the source rather than compensated for at each
 * comparison. `TZ=UTC` fixes the instant, `LC_ALL=C` fixes the field order and
 * the month/weekday names; together they make the string a function of the
 * process alone.
 *
 * The tag is the other half, and it is what makes the format change SURVIVABLE
 * rather than silent. Pinning changes the bytes for every identity already on
 * disk — even on a machine that was already in UTC, because `LC_ALL=C` also
 * reorders the fields ("Thu Aug 20 …" against "Thu 20 Aug …"). An untagged
 * recorded value is therefore not comparable to a tagged one, and it is not a
 * MISMATCH either: "a stranger holds this pid" would be a false statement
 * about the world. Callers detect it with `isPinnedIdentity` and refuse
 * explicitly. See `down`'s `anchorIdentity` for the policy that rests on this.
 */
export const IDENTITY_FORMAT = "utc1";

/** Environment that makes `ps -o lstart=` a function of the process alone. */
const IDENTITY_PS_ENV = { TZ: "UTC", LC_ALL: "C" } as const;

/**
 * A `ps` read of a process's start time that did not produce one, for a reason
 * OTHER than the process being gone.
 *
 * THE IDENTITY HALF of the fact `GroupReadError` records for the group, and it
 * is the same defect one channel over rather than a new one. "The process is
 * not there" and "I could not find out" are different facts with opposite safe
 * answers, and `processStartTime` used to return `null` for both.
 *
 * What that `null` reaches. `down`'s `anchorIdentity` maps it to
 * `{kind: "gone"}` — the ONE anchor verdict that reports `stopped: true`, calls
 * `reapContainer()` (`docker rm -f`) and makes the worker PRUNABLE. So a
 * transient `ps` failure against a LIVE supervisor reported it stopped,
 * force-removed its container, and let `--prune` delete the checkout it was
 * still writing to. `processGroupId` was fixed for exactly this and the
 * identity channel was left carrying it, which is why this is a carry-in of the
 * Phase F review rather than a fresh finding.
 *
 * Thrown rather than returned, for the reason `GroupReadError` is: there is no
 * in-band value for a caller to forget to look at.
 *
 * CARRIES AN `exitCode` WHERE `GroupReadError` DOES NOT, and the asymmetry is
 * deliberate. Every `processGroupId` call goes through `confirmGroup`, which
 * catches and converts to `read_failed`, so its error never reaches the CLI.
 * This one has callers that do not catch (see `processStartTime` below), and an
 * error with no `exitCode` is reported by the entry point as `EXIT.INTERNAL` —
 * "a bug in pifleet itself". A `ps` that cannot be read is an environment
 * failure, so it takes `BACKEND_UNAVAILABLE`, the code `StateReadError` and
 * `RunPolicyUnreadableError` already use for unreadable control-plane state.
 */
export class IdentityReadError extends Error {
  readonly exitCode = EXIT.BACKEND_UNAVAILABLE;

  constructor(
    readonly pid: number,
    detail: string,
  ) {
    super(
      `could not read the start time of pid ${pid}: ${detail}. This is NOT the process being ` +
        `gone — nothing here can tell whether it is alive, so nothing may be stopped, reaped or ` +
        `pruned on the strength of this read.`,
    );
    this.name = "IdentityReadError";
  }
}

/** The `ps` spawn, factored out ONLY so `proc`'s type can be named below. */
function spawnIdentityPs(pid: number) {
  return Bun.spawn(["ps", "-o", "lstart=", "-p", String(pid)], {
    // Explicitly, not inherited. This is the whole fix: without it the
      // token carries the caller's TZ and locale into a value that another
      // process, in another environment, compares byte-for-byte.
      env: { ...process.env, ...IDENTITY_PS_ENV },
    stdout: "pipe",
    stderr: "pipe",
  });
}

/**
 * Start time of a pid as a tagged, environment-independent token. `null` means
 * `ps` AFFIRMATIVELY reported no such process; a read that failed for any other
 * reason throws `IdentityReadError`.
 *
 * Never returns the empty string: `""` is the CAPTURE-FAILED sentinel that
 * callers persist via `?? ""`, and it must be read as exactly that and never as
 * an identity.
 *
 * WHAT "AFFIRMATIVELY GONE" LOOKS LIKE, measured on this machine (Darwin 25.5,
 * the base-system `ps`) for `-o lstart=` specifically rather than inherited
 * from the `-o pgid=` reading in `safety/kill.ts`. Same five readings twice:
 *
 *   a live pid                         exit 0  stdout "Fri Aug 21 04:14:42 2026"  stderr ""
 *   a pid that exited and was reaped   exit 1  stdout ""                          stderr ""
 *   pid 999999999, above the ceiling   exit 1  stdout ""                          stderr "ps: process id too large: 999999999"
 *   `-p not-a-number`                  exit 1  stdout ""                          stderr "ps: Invalid process id: not-a-number"
 *   an unknown flag                    exit 1  stdout ""                          stderr "ps: illegal option -- -"
 *
 * THE EXIT CODE IS NOT THE DISCRIMINATOR, and neither is stdout: a reaped pid
 * and a malformed invocation are byte-identical on both. The one thing that
 * separates them is that a genuinely-absent process is the case where `ps` says
 * NOTHING on all three channels. So stderr is captured rather than ignored —
 * `stderr: "ignore"` was the whole reason the old `exitCode !== 0 ||
 * out.length === 0` test could not have been written correctly — and silence
 * everywhere is what `null` means.
 *
 * EXIT 0 WITH EMPTY STDOUT THROWS TOO, and it is a separate branch rather than
 * a fold into the one above. `ps` claiming success and printing nothing is a
 * broken read, emphatically not "no such process"; the old condition's
 * `|| out.length === 0` swept it into the destructive answer.
 *
 * Linux `procps` was NOT probed, for the reason `processGroupId` records: a
 * platform whose `ps` writes a diagnostic for an absent pid degrades to a
 * throw, which REFUSES. The cost is a dead supervisor's container outliving it
 * until a later scan, never a live supervisor's container being destroyed.
 *
 * ## Every call site, checked — because a throw where a caller expected `null`
 * ## is a new crash rather than a fix
 *
 * CHECK SITES map `null` to "gone" or "dead" and are the ones this fix is for.
 * `down`'s `anchorIdentity`, `status`, `dispatch`'s liveness probe, `wait`,
 * `identityAlive` below, and `kill.ts`'s `realProcessOps.startTime` (and
 * through it `sameIdentity` and every rung of the ladder) all now REFUSE on an
 * unreadable `ps` instead of declaring the process gone. Every one of those is
 * fail-closed in the direction that matters. The per-worker verdict this
 * originally deferred now EXISTS: `down` reports `identity_read_failed`
 * alongside `group_read_failed`, `signalIfSame` and `runKillLadder` answer
 * `identity_unconfirmed`, and a broken `ps` on one worker therefore refuses
 * that worker instead of aborting the run. Review found the deferral was not
 * merely coarse — the whole worker loop sits outside a try, so an escaping
 * read took the command with it.
 *
 * CAPTURE SITES persist `?? ""` and genuinely want leniency:
 * `startRegistryDaemon` below, `supervisor/index.ts`, and `up.ts` for a pid
 * `launchDetached` has just returned. NOTE the third is weaker than the other
 * two and review said so: `up.ts`'s pid is a freshly-spawned CHILD, not
 * `process.pid`, so "alive by construction" does not strictly hold — it can be
 * reaped between launch and read. The consequence is the `""` sentinel, which
 * every reader already treats as capture-failed, so the leniency is still the
 * right call there; it is recorded rather than glossed. None is forced onto
 * the strict path and
 * none needed to be, because for all three the pid is alive BY CONSTRUCTION —
 * two of them read `process.pid` — so `ps` answers exit 0 with a start time and
 * neither the `null` nor the throw is reachable. The throw becomes reachable
 * for them only if `ps` itself is broken on the host, and aborting there is the
 * honest outcome rather than a regression: every identity the run would go on
 * to record is the capture-failed sentinel, so no later `down` could stop any of
 * its workers without `--force-identity`. Failing at launch beats creating a run
 * that cannot be safely stopped.
 *
 * @throws {IdentityReadError} `ps` could not be read.
 */
export async function processStartTime(pid: number): Promise<string | null> {
  /*
   * THE SPAWN ITSELF CAN THROW, and that is the likeliest real instance of
   * "the measuring instrument is broken": a minimal container image with no
   * procps. `Bun.spawn` raises `Error: Executable not found in $PATH: "ps"`
   * synchronously, with no `exitCode` — so without this wrapper the entry
   * point reports `EXIT.INTERNAL`, "a bug in pifleet itself", for an
   * environment failure. `down.ts` already wraps its `docker` spawn for
   * exactly this reason.
   */
  let proc: ReturnType<typeof spawnIdentityPs>;
  try {
    proc = spawnIdentityPs(pid);
  } catch (err) {
    throw new IdentityReadError(pid, `ps could not be started: ${String(err)}`);
  }
  // Both pipes concurrently. Draining one to EOF while the other fills its
  // buffer is how a tiny read becomes a deadlock on the day `ps` gets chatty —
  // and it does: the illegal-flag reading above is a five-line usage block.
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
    throw new IdentityReadError(
      pid,
      err.length > 0
        ? err
        : proc.signalCode !== null
          ? `ps was killed by ${proc.signalCode} before it could answer`
          : `ps exited ${String(proc.exitCode)} without saying why`,
    );
  }
  if (out.length === 0) {
    // Exit 0 with nothing on stdout. `ps` claimed success and told us nothing.
    throw new IdentityReadError(pid, "ps exited 0 and printed no start time");
  }
  return `${IDENTITY_FORMAT} ${out}`;
}

/**
 * Whether a recorded `started` was written by a build that pinned the
 * rendering, and can therefore be compared at all.
 *
 * False for `""` (capture failed — see `processStartTime`) and for any value
 * written before the pin existed. No locale renders a weekday as `utc1`, so
 * the tag cannot collide with a legacy value.
 */
export function isPinnedIdentity(recorded: string): boolean {
  return recorded.startsWith(`${IDENTITY_FORMAT} `);
}
