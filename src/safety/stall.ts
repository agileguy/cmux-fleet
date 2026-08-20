/**
 * The stall policy (ISC-110, ISC-117): when event silence means a kill.
 *
 * DELIBERATELY DEPENDENCY-FREE — this module imports nothing, and that is a
 * structural requirement rather than a happy accident. Its natural home is
 * `kill.ts` beside the ladder it starts, but `kill.ts` sits inside an
 * order-dependent initialisation cycle (`kill.ts` -> `run/registry.ts` -> … ->
 * `safety/reaper.ts` -> `kill.ts`) that throws `ReferenceError: Cannot access
 * 'realProcessOps' before initialization` for whichever module imports
 * `kill.ts` first. `scheduler.ts` became that module the moment the policy
 * acquired a production caller. A module with no imports cannot be part of a
 * cycle, so this one is safe to import from anywhere — including from the
 * scheduler's hot loop.
 *
 * `kill.ts` re-exports everything here, so the policy's documented address is
 * unchanged for every existing caller.
 */

export type StallVerdict = "healthy" | "warn" | "kill";

export interface StallInput {
  /** Monotonic ms since the worker's last event — a Stopwatch reading. */
  sinceLastEventMs: number;
  /**
   * Whether the worker's current task holds an admission slot
   * (`BudgetManager.holdsSlot`). This is the discriminator ISC-110 turns on:
   * a QUEUED worker and a WEDGED one are byte-identical if all you watch is
   * event silence — neither emits anything — so silence alone must never be
   * grounds for a kill. A slot holder is generating; its silence is spent
   * inference time and bounded by `event_stall_kill`. A non-holder is waiting
   * its turn behind `max_concurrent` (SRD §9.3/F40); its silence is the queue
   * working as designed.
   */
  holdsSlot: boolean;
  warnMs: number;
  killMs: number;
}

/**
 * Classify a worker's event silence.
 *
 * Only a slot holder can reach `kill` (ISC-117: no events, live heartbeat,
 * holding the server — wedged). A queued worker saturates at `warn`, however
 * long it queues: killing it would be executing a worker for standing in the
 * line we put it in. Its supervisor's own liveness is the reaper's job, not
 * the stall policy's.
 */
export function classifyStall(input: StallInput): StallVerdict {
  if (input.holdsSlot && input.sinceLastEventMs >= input.killMs) return "kill";
  if (input.sinceLastEventMs >= input.warnMs) return "warn";
  return "healthy";
}
