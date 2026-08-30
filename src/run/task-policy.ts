/**
 * Task provenance for the verbgate ledger, delivered as a HOST-WRITTEN FILE.
 *
 * The verbgate stamps every cloud verb it classifies with the task and epoch
 * that verb belongs to. It used to read both from `PIFLEET_TASK_ID` and
 * `PIFLEET_EPOCH`, which nothing in `src/` ever set — so every row in every
 * production ledger read `"task_id":"<none>","epoch":0`, and the audit trail
 * recorded THAT a destructive verb was attempted while losing WHICH task
 * attempted it (ISC-360, found by the 2026-08-30 documentation audit).
 *
 * Environment is the wrong carrier for this, for two independent reasons, and
 * the obvious fix — set the two variables in the worker's `--env-file` — is
 * wrong on both:
 *
 * 1. **It is fixed at launch and the value is not.** A worker container is
 *    long-lived and takes many epochs over its life (`src/rpc/epoch.ts`): a
 *    dispatch is a prompt to a running Pi process, not a new container. An
 *    env var written at materialize time would name the FIRST task forever,
 *    so every subsequent epoch would be misattributed — a ledger that looks
 *    authoritative and is wrong, which is worse than one that admits `<none>`.
 *
 * 2. **The worker controls it.** `verbgate`'s own header says so. A process
 *    that can `export PIFLEET_TASK_ID` can forge the provenance on its own
 *    audit rows, which is precisely the field an investigator would trust.
 *
 * A file bind-mounted read-only from the run tree fixes both: the supervisor
 * rewrites it at each dispatch, and the worker cannot write it. It is the same
 * shape as `/policy/cloud-allow`, and deliberately so — one policy surface,
 * one integrity rule, one recipe for rewriting it.
 *
 * ## The rewrite recipe is load-bearing
 *
 * `materialize.ts` states the hazard for whoever wired this: a bind mount pins
 * the INODE, so tmp-file + rename swaps the file the HOST sees while the
 * container keeps reading the old one for the life of the container, with both
 * sides believing the policy changed. Every write here is therefore
 * chmod 0644 -> truncate in place -> chmod 0444, never rename. `writeFile`
 * with the default `w` flag truncates an existing file rather than replacing
 * it, so the inode survives; `test/unit/task-policy.test.ts` asserts that
 * directly rather than trusting the flag.
 */
import { writeFile } from "node:fs/promises";

import { makeWorkerReadable } from "../container/mounts.ts";

/** Where the run-tree file lands inside the worker container. */
export const TASK_POLICY_MOUNT = "/policy/task";

/**
 * The spelling of "no task is live" — shared with `verbgate`'s own fallback so
 * a missing mount and an idle worker read identically in the ledger.
 */
export const TASK_POLICY_NONE = "<none>";

/**
 * Control characters and DEL: the set that breaks the line format rather than
 * the set that breaks JSON. `verbgate` strips the JSON-hostile ones at its own
 * end because it must not trust this file.
 */
const LINE_HOSTILE = /[\u0000-\u001f\u007f]/gu;

/**
 * Line 1 is the task id, line 2 the epoch. Two lines rather than one delimited
 * field pair because `verbgate` is POSIX `sh` reading with `sed -n 1p`/`2p`,
 * and a split-on-delimiter parse would need the delimiter to be illegal in a
 * task id — a constraint nothing upstream enforces.
 *
 * Both fields are sanitized HERE as well as in `verbgate`. The gate sanitizes
 * because it must not trust the file; this end sanitizes because a task id
 * carrying a newline would silently shift the epoch onto line 3 and hand the
 * gate an empty epoch — a formatting break, not an injection, and one no
 * amount of care at the reading end can distinguish from a legitimate value.
 */
export function renderTaskPolicy(taskId: string | null, epoch: number): string {
  const id = taskId === null || taskId === "" ? TASK_POLICY_NONE : taskId;
  const safeId = id.replace(LINE_HOSTILE, "").slice(0, 200) || TASK_POLICY_NONE;
  const safeEpoch = Number.isFinite(epoch) && epoch >= 0 ? Math.floor(epoch) : 0;
  return `${safeId}\n${safeEpoch}\n`;
}

/**
 * Rewrite the policy file IN PLACE, preserving the inode the container's bind
 * mount is pinned to.
 *
 * The file is 0444 between writes — the worker must never hold write
 * permission on the record of its own actions — so the mode is widened for the
 * write and restored immediately. On POSIX the owner of a 0444 file cannot
 * open it for writing either, so this is not ceremony: skip the first chmod
 * and the second dispatch of a run fails.
 */
export async function writeTaskPolicy(
  file: string,
  taskId: string | null,
  epoch: number,
): Promise<void> {
  /**
   * The widen is skipped only when the file does not exist YET — the very
   * first write, which creates the inode the bind mount will pin. Any other
   * chmod failure is real and propagates: a policy file whose mode could not
   * be restored to 0444 must not be papered over, because the next thing that
   * happens is the worker holding write permission on the record of its own
   * actions.
   */
  try {
    await makeWorkerReadable(file, true);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
  }
  await writeFile(file, renderTaskPolicy(taskId, epoch));
  await makeWorkerReadable(file, false);
}
