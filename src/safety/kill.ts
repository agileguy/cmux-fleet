/**
 * The general kill ladder (ISC-116, ISC-117, ISC-191) and the stall policy
 * that decides when to climb it.
 *
 * A pid is not an identity. Pids are reused — quickly, on a machine that
 * forks as much as this one — and a ladder that checks the pid once at the
 * top and then escalates will eventually SIGKILL an innocent process that
 * inherited the number between rungs. The unit of killing is therefore
 * `ProcId` — `(pid, started)` from contracts.ts — and the pair is re-read
 * from the OS and compared at EVERY rung, not once at the start (ISC-191).
 * The re-read is `registry.ts`'s `processStartTime`; this module deliberately
 * does not reimplement it, it injects it, which is also what makes the ladder
 * testable without spawning anything.
 *
 * The ladder is: abort → await dead → SIGTERM → grace → SIGKILL, signalling
 * the process GROUP where the caller says one exists. The supervisor already
 * has a 5-second `ABORT_GRACE_MS` escalation hard-wired to the deadline case;
 * this is the general one, used by `down`'s quiesce (SRD §9.3), the wedged-
 * agent path (ISC-117), and — minus the abort rung, which a wedged supervisor
 * cannot answer — the reaper (safety/reaper.ts).
 *
 * A task exceeding `deadline_s` settles `timed_out`, which `wait` already
 * maps to exit 4 (ISC-116); `TaskDeadlineError` is the diagnosed form for a
 * caller that needs to exit directly.
 *
 * Timing: every wait in here runs on the injected monotonic clock through
 * `Deadline`, and every pause bounds itself with `boundedBy` so a poll can
 * never outlive the grace that contains it (ISC-146). `Date.now()` appears
 * nowhere; test/unit/clock.test.ts greps this file to keep it that way
 * (ISC-155).
 */

import { EXIT, type ExitCoded, type ProcId } from "../contracts.ts";
import { processStartTime } from "../run/registry.ts";
import { Deadline, monotonicMs } from "../util/clock.ts";

// ---------------------------------------------------------------------------
// Process operations — injected, so tests never signal a real pid by accident.
// ---------------------------------------------------------------------------

export interface ProcessOps {
  /** Start time of a pid from the OS, or null if no such process. */
  startTime(pid: number): Promise<string | null>;
  /** Send a signal. A negative pid addresses the process group. */
  signal(pid: number, sig: "SIGTERM" | "SIGKILL"): void;
}

export const realProcessOps: ProcessOps = {
  startTime: processStartTime,
  signal(pid, sig) {
    process.kill(pid, sig);
  },
};

/** True only if the pid is alive AND still the process the caller recorded. */
export async function sameIdentity(target: ProcId, ops: ProcessOps): Promise<boolean> {
  const started = await ops.startTime(target.pid);
  return started !== null && started === target.started;
}

/**
 * Re-validate identity, then signal — the ISC-191 primitive, one atom.
 *
 * Returns false without signalling when the recorded process no longer
 * exists. The check-then-signal window is not zero; a process that dies in it
 * surfaces as ESRCH, which is the same fact ("already gone") arriving late,
 * so it is swallowed rather than escalated. Any other error is real.
 */
export async function signalIfSame(
  target: ProcId,
  sig: "SIGTERM" | "SIGKILL",
  opts: { pgid?: number | null; ops?: ProcessOps } = {},
): Promise<boolean> {
  const ops = opts.ops ?? realProcessOps;
  if (!(await sameIdentity(target, ops))) return false;
  const addr = opts.pgid != null && opts.pgid > 0 ? -opts.pgid : target.pid;
  try {
    ops.signal(addr, sig);
  } catch (err) {
    if ((err as { code?: string }).code === "ESRCH") return false;
    throw err;
  }
  return true;
}

// ---------------------------------------------------------------------------
// The ladder
// ---------------------------------------------------------------------------

/**
 * How the climb ended. Everything except `unconfirmed` means the target is
 * gone; `already_gone` specifically means it was never signalled because the
 * recorded identity no longer existed — reaping the dead is a no-op, not an
 * error (ISC-118).
 */
export type KillOutcome = "aborted" | "terminated" | "killed" | "already_gone" | "unconfirmed";

export interface KillLadderOpts {
  /** The recorded identity to kill. Never a bare pid. */
  target: ProcId;
  /** Process group to address for SIGTERM/SIGKILL; identity is checked on the leader. */
  pgid?: number | null;
  /**
   * Advisory abort (Pi's `abort` RPC). Null skips the rung — a wedged
   * supervisor has no RPC to answer on, which is the reaper's case.
   */
  abort?: (() => Promise<void>) | null;
  /**
   * Positive death signal — child exited, phase `dead`. The ladder waits on
   * THIS, never on a timer race: "no events for a while" is what a queued
   * worker looks like, and racing a timer against death is how the innocent
   * get killed. Defaults to identity disappearance when the caller has no
   * better signal.
   */
  dead?: (() => Promise<boolean>) | null;
  abortGraceMs?: number;
  termGraceMs?: number;
  killGraceMs?: number;
  pollMs?: number;
  ops?: ProcessOps;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

const DEFAULT_ABORT_GRACE_MS = 5_000;
const DEFAULT_TERM_GRACE_MS = 5_000;
const DEFAULT_KILL_GRACE_MS = 2_000;
const DEFAULT_POLL_MS = 100;

function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Wait for `dead()` to turn true, bounded by a grace period. Polling is
 * bounded by `boundedBy` so the final pause shrinks to what remains of the
 * grace rather than overshooting it — a sub-wait must never outlive its
 * parent budget (clock.ts).
 */
async function awaitDead(
  dead: () => Promise<boolean>,
  graceMs: number,
  pollMs: number,
  now: () => number,
  sleep: (ms: number) => Promise<void>,
): Promise<boolean> {
  const grace = new Deadline(graceMs, now);
  for (;;) {
    if (await dead()) return true;
    if (grace.expired()) return false;
    await sleep(grace.boundedBy(pollMs));
  }
}

/**
 * Climb: abort → await dead → SIGTERM → grace → SIGKILL.
 *
 * Identity is re-validated at every rung. The sequence of checks is not
 * paranoia-by-repetition: each grace period is a window in which the target
 * can die and the kernel can hand its pid to someone new, so the validity of
 * "signal pid N" expires with every await and must be re-established before
 * the next signal — never carried forward from the rung before.
 */
export async function runKillLadder(opts: KillLadderOpts): Promise<KillOutcome> {
  const ops = opts.ops ?? realProcessOps;
  const now = opts.now ?? monotonicMs;
  const sleep = opts.sleep ?? realSleep;
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS;
  const target = opts.target;
  const dead = opts.dead ?? (async () => !(await sameIdentity(target, ops)));

  // Rung 0: is the recorded process even there? Reaping the already-dead is
  // the idempotent no-op ISC-118 requires, and the guard that keeps a recycled
  // pid from being signalled at all.
  if (!(await sameIdentity(target, ops))) return "already_gone";

  // Rung 1: advisory abort, when the target can hear one.
  if (opts.abort != null) {
    await opts.abort().catch(() => {
      // Advisory means advisory: a refused or timed-out abort proves nothing
      // except that the next rung is needed.
    });
    if (await awaitDead(dead, opts.abortGraceMs ?? DEFAULT_ABORT_GRACE_MS, pollMs, now, sleep)) {
      return "aborted";
    }
  }

  // Rung 2: SIGTERM, re-validated. `false` here means the target died inside
  // the abort grace without `dead()` noticing — gone before we ever signalled.
  if (!(await signalIfSame(target, "SIGTERM", { pgid: opts.pgid, ops }))) {
    return opts.abort != null ? "aborted" : "already_gone";
  }
  if (await awaitDead(dead, opts.termGraceMs ?? DEFAULT_TERM_GRACE_MS, pollMs, now, sleep)) {
    return "terminated";
  }
  // `dead()` can lag the truth (it may read a state file); the OS does not.
  if (!(await sameIdentity(target, ops))) return "terminated";

  // Rung 3: SIGKILL. No grace can save the target now; the wait only exists
  // so the caller gets a confirmed answer rather than a hopeful one.
  if (!(await signalIfSame(target, "SIGKILL", { pgid: opts.pgid, ops }))) return "terminated";
  if (await awaitDead(dead, opts.killGraceMs ?? DEFAULT_KILL_GRACE_MS, pollMs, now, sleep)) {
    return "killed";
  }
  return (await sameIdentity(target, ops)) ? "unconfirmed" : "killed";
}

// ---------------------------------------------------------------------------
// Stall policy (ISC-110, ISC-117) — re-exported, defined in ./stall.ts
// ---------------------------------------------------------------------------

/**
 * The policy itself lives in `./stall.ts`, which imports NOTHING.
 *
 * It was moved there when `scheduler.ts` became its first production caller
 * and the import tripped the order-dependent initialisation cycle this file
 * has carried since the reaper landed: `kill.ts` -> `run/registry.ts` -> … ->
 * `safety/reaper.ts` -> `kill.ts`, which throws `ReferenceError: Cannot access
 * 'realProcessOps' before initialization` for whichever module happens to
 * import `kill.ts` first. The ISA records that failure on ISC-110 as a cost
 * paid to establish; nothing should have to pay it again to ask a pure
 * question about two integers.
 *
 * A dependency-free module cannot participate in a cycle, so the policy is now
 * importable from anywhere. The re-export keeps `kill.ts` the address every
 * existing caller and every doc comment already uses.
 */
export { classifyStall, type StallInput, type StallVerdict } from "./stall.ts";

// ---------------------------------------------------------------------------
// Deadline exhaustion (ISC-116) — the diagnosed form.
// ---------------------------------------------------------------------------

/**
 * A task that exceeded `deadline_s`. The supervisor settles the task
 * `timed_out` and `wait` maps that verdict to exit 4; this error is the
 * structural `ExitCoded` for a code path that must exit directly instead of
 * settling — same protocol, same integer, one place it is written down.
 */
export class TaskDeadlineError extends Error implements ExitCoded {
  readonly exitCode = EXIT.TIMEOUT;

  constructor(taskId: string, deadlineS: number) {
    super(`task ${taskId} exceeded deadline_s ${deadlineS}; settled timed_out`);
    this.name = "TaskDeadlineError";
  }
}
