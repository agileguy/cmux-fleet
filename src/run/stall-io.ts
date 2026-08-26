/**
 * The stall policy's two PRODUCTION inputs and its one action (ISC-282).
 *
 * `safety/stall.ts` holds the POLICY — `classifyStall`, a pure function with
 * no imports, kept that way deliberately because importing it from `kill.ts`
 * tripped an order-dependent init cycle this ISA records on ISC-110. This
 * module is the other half: the IO that feeds that policy a real number and
 * carries out its verdict. It is a separate file for the same reason the
 * policy is — the policy must stay importable from anywhere, and this side
 * necessarily reaches the filesystem and the control socket.
 *
 * WHY IT IS A MODULE AT ALL, rather than two methods on the object literal in
 * `cli/commands/dispatch.ts` where they used to live. They were unreachable:
 * `const io: SchedulerIO = {...}` is built inside `register()`'s action
 * handler, closed over a `run` and a `ledger` that only exist once a CLI
 * invocation is under way, so nothing could construct one to test. That is
 * the RC-1 shape — a correct implementation beside a path nothing exercises —
 * and ISC-282 was filed precisely because these two were sitting in it while
 * ISC-110 and ISC-117 rested on an injected clock and a fake silence.
 *
 * `dispatch.ts` now delegates to both. The adapter still exists — the
 * scheduler is handed a `SchedulerIO`, not this module — but it holds the
 * binding and not the behaviour, so a test that drives these functions drives
 * what production runs.
 */

import { stat } from "node:fs/promises";

import { workerPaths, type RunPaths } from "./paths.ts";
import { controlCall } from "../supervisor/launch.ts";

/** How long `abortWedged` waits for the supervisor to answer. */
export const ABORT_RPC_TIMEOUT_MS = 10_000;

/** The subset of `LedgerWriter` this module needs, so callers can pass the real one. */
export interface StallLedger {
  append(
    event: string,
    fields?: { worker?: string; task_id?: string; detail?: Record<string, unknown> },
  ): Promise<void>;
}

/**
 * Milliseconds since `worker` last appended to its `events.jsonl`.
 *
 * MTIME rather than a parsed last record, deliberately. The file is
 * append-only and every append moves its mtime, so the mtime IS the last
 * event's arrival time — and reading it is one `stat` per worker per poll
 * rather than a tail-and-parse of a file that grows for the whole run. What
 * the parse would buy is the event's own `ts` field, which is stamped by the
 * supervisor and would have to be trusted across a clock the scheduler does
 * not share.
 *
 * `null` when the file does not exist: the worker has emitted nothing at all
 * since launch, so there is no last event to measure from. Reporting a large
 * silence here would kill workers that are merely still starting, which
 * inverts the criterion — a worker whose supervisor has not yet touched the
 * file would read as maximally wedged at the moment it is most innocent.
 *
 * Both readings are taken in THIS function's clock and only their difference
 * leaves it, which is why `now` is a parameter rather than the scheduler's
 * `io.now()`: the scheduler must never subtract a filesystem mtime from its
 * own clock, because under a fake or offset clock the difference is not a
 * duration at all. The default is the only one production uses.
 *
 * Clamped at 0. A file whose mtime is in the future — a clock step, or a
 * mount whose timestamps lead — would otherwise read as a NEGATIVE silence,
 * which compares below every threshold and would silently exempt that worker
 * from the policy for as long as the skew lasted.
 */
export async function eventSilenceMs(
  run: RunPaths,
  worker: string,
  now: () => number = Date.now,
): Promise<number | null> {
  try {
    const st = await stat(workerPaths(run, worker).eventsJsonl);
    return Math.max(0, now() - st.mtimeMs);
  } catch {
    return null;
  }
}

/**
 * End a wedged worker (ISC-117).
 *
 * The ADVISORY rung only: an `abort` RPC to the supervisor, which is alive and
 * answering by construction — that is what makes this case different from the
 * reaper's, where the supervisor itself is the thing that stopped. Signalling
 * is deliberately NOT done here. The identity-anchored ladder in `down` is the
 * one place that decides a process may be signalled, and duplicating any part
 * of that decision on the scheduler's path is how the two would come to
 * disagree.
 *
 * Best-effort against the RPC, and NOT best-effort against the ledger. The
 * `worker_stall_kill` record is appended FIRST and its failure propagates,
 * because that record is the only durable evidence the policy fired; a run
 * that killed a worker and left no trace is worse than one that failed loudly.
 * The `controlCall` that follows may fail freely: a wedged agent may have no
 * working RPC, and that is consistent with the diagnosis rather than evidence
 * against it. The scheduler settles the task and marks the worker dead either
 * way, because the classification — not this call's success — is the finding.
 */
export async function abortWedged(args: {
  run: RunPaths;
  worker: string;
  taskId: string;
  ledger: StallLedger;
  timeoutMs?: number;
}): Promise<void> {
  const { run, worker, taskId, ledger } = args;
  await ledger.append("worker_stall_kill", {
    detail: { worker, task_id: taskId, reason: "event_stall_kill" },
  });
  await controlCall(
    run,
    worker,
    { cmd: "abort" },
    { timeoutMs: args.timeoutMs ?? ABORT_RPC_TIMEOUT_MS },
  ).catch(() => {});
}
