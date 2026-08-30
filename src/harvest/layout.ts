/**
 * The outbox's LAYOUT, checked against what was actually dispatched
 * (SRD §5.5, §8.4).
 *
 * `outbox.ts` decides whether the bytes under `<outbox>/<task-id>/files/` can
 * be trusted, and `reconcile.ts` compares those bytes against the envelope's
 * claims. Both start from the same premise: that the worker put its output
 * where the task told it to. Nothing checked the premise.
 *
 * ## The measured failure this module exists for
 *
 * A live ticketing worker was dispatched task `my-iteration-2` and wrote its
 * artifact to `<run>/outbox/tick-1/list-tickets-2026-08-29/` — a directory
 * named after its own idea of the job rather than after the task id it was
 * given. The harvester looked in `<run>/outbox/tick-1/my-iteration-2/`, found
 * an empty region, scanned nothing, validated nothing, swept nothing for
 * credentials, and reported a clean harvest. The operator's whole signal was
 * an absence, and an absence reads exactly like a quiet success.
 *
 * That is the failure shape this repo keeps finding in itself: a mechanism
 * that is present, tested and invoked, running over an empty input, publishing
 * a clean result. ISC-333 is the same shape at the needle supplier; ISC-231 is
 * the same shape at the mount path. The fix in every case is the same one — say
 * out loud that nothing was checked, and why.
 *
 * ## Why this is a directory listing and not a search
 *
 * The obvious repair is to go looking for the worker's output wherever it
 * ended up and harvest it from there. That is exactly the wrong direction, and
 * §12.5 is why: everything under `<run>/outbox/<worker>/` is worker-authored,
 * and the harvester's whole defensive posture is that it reads only inside the
 * one region a dispatch named, through descriptors that were validated on the
 * way in. Harvesting an arbitrary worker-chosen directory would make the
 * region the WORKER picks, which hands it the choice of what the harvester
 * opens.
 *
 * So this module never descends, never opens, never stats a leaf. It reads one
 * directory level with `readdir`, compares NAMES against the dispatched set,
 * and reports. The output is a sentence, not a widened scan.
 */

import type { Dirent } from "node:fs";
import { readdir } from "node:fs/promises";
import { basename, dirname } from "node:path";

import { safeForReport } from "./outbox.ts";
import { workerOutboxDir, workerVerbgateLedger, type RunPaths } from "../run/paths.ts";

/**
 * Unexplained directories NAMED in one finding before the list is truncated.
 *
 * A cap and not a nicety. `HarvestSchema` caps `discrepancies` at `MAX_ITEMS`
 * (1,000) and REFUSES a longer array, so an uncapped one-finding-per-directory
 * loop would let a worker that created 1,001 directories throw
 * `HarvestSchema.parse` — which `harvestAll` catches into a single
 * `unavailable` row, destroying the report for the very run that misbehaved.
 * A detector whose own output can suppress the report is worse than no
 * detector.
 *
 * Eight rather than one, because the count is the diagnosis: a worker that
 * wrote one misnamed directory made a mistake, and a worker that wrote forty
 * is doing something else entirely. The finding declares its own truncation so
 * a reader is never left inferring that the list is complete.
 */
export const MAX_NAMED_UNEXPLAINED_DIRS = 8;

/**
 * The one directory under a worker's outbox that is legitimately not a task.
 *
 * DERIVED from `workerVerbgateLedger` rather than spelled `"ledger"` here, and
 * the derivation is the whole point. `docker/verbgate` creates
 * `/outbox/ledger/` with its own `mkdir -p` on the first gated verb — nothing
 * on the host creates it and nothing on the host is asked before it appears —
 * so it is present in every run where a worker ran a gated `gcloud`, and it is
 * a name no task will ever have.
 *
 * A hard-coded `"ledger"` here would be a second spelling of a path
 * `run/paths.ts` already owns, which is the exact hazard that module's header
 * is written against. Worse than usual in this direction: if the ledger moved
 * and this string did not follow, the harvest would start reporting every
 * worker that ran a gated verb as having written a stray directory — a finding
 * that fires on correct behaviour, which is the failure mode this whole module
 * has to avoid to be worth having.
 */
function ledgerDirName(runRoot: string, workerId: string): string {
  return basename(dirname(workerVerbgateLedger(runRoot, workerId)));
}

/**
 * Every task the run holds a durable dispatch record for.
 *
 * THE SINGLE SOURCE, and it is shared with `harvestAll` deliberately rather
 * than reimplemented here. The question this module asks — "is this directory
 * name a task?" — has to be answered by the same list that decides which tasks
 * get harvested at all, or the two drift and the drift is silent in the worst
 * direction: a task whose id this function did not recognise but `harvestAll`
 * did would be reported as an unexplained directory on every one of its
 * sibling tasks' harvests, forever, for having been dispatched normally.
 *
 * ISC-345's finding, applied before it can happen again: two readers of one
 * fact, written independently, is how a value-reader goes blind while its
 * sibling keeps working.
 *
 * An unreadable inbox yields an empty list rather than a throw. `harvestTask`
 * has already read its own dispatch record by the time this runs — so the
 * inbox demonstrably exists — but a directory that cannot be listed must not
 * take the harvest down with it, and the caller treats an empty set as "say
 * nothing" rather than as "everything is an orphan". See `unexplainedOutboxDirs`.
 */
export async function dispatchedTaskIds(run: RunPaths): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(run.inboxDir);
  } catch {
    return [];
  }
  return entries
    .filter((e) => e.endsWith(".json") && !e.startsWith("."))
    .map((e) => e.slice(0, -".json".length))
    .sort();
}

/**
 * Findings about directories under one worker's outbox that no dispatch
 * explains. Already escaped; safe to print.
 *
 * ## THE FALSE-POSITIVE ARGUMENT, because this is the check that could ruin
 * ## every harvest in the repo if it were wrong
 *
 * A worker legitimately owns `<run>/outbox/<worker>/` and legitimately writes
 * several things into it. Three of them must never produce a finding:
 *
 *   1. **Its OTHER tasks.** One worker serves many tasks in a run, so
 *      `<worker>/t1/` and `<worker>/t2/` coexist and BOTH are correct while
 *      either one is being harvested. The comparison is therefore against
 *      every dispatched id in the run, never against `loc.taskId`. Scoping it
 *      to the task under harvest would report every multi-task worker's entire
 *      outbox as stray — a finding that fires on the normal case, which is
 *      worse than no finding at all.
 *   2. **The verbgate ledger.** See `ledgerDirName`.
 *   3. **Files.** `readdir` with `withFileTypes` answers from the entry's own
 *      type without a second syscall, and only `isDirectory()` entries are
 *      considered. A worker that drops a loose `notes.txt` at the top of its
 *      outbox is untidy, not misrouted, and this module has no opinion about
 *      it. That also settles symlinks by construction: a symlink is reported
 *      as a symlink, never as a directory, so nothing here can be tricked into
 *      naming — let alone following — a link out of the run tree.
 *
 * ## The empty-dispatch guard, which is the fourth and least obvious one
 *
 * If `dispatchedTaskIds` comes back empty the comparison degenerates: EVERY
 * directory is unexplained, and the harvest fills with findings manufactured
 * by a failed `readdir` rather than by anything a worker did. The caller is
 * already inside `harvestTask`, which only reaches this point by having
 * successfully read its own inbox record, so an empty set means the inbox
 * became unreadable underneath a live harvest. Saying nothing is the honest
 * answer to that; the alternative is a report whose loudest content is an
 * artifact of its own instrumentation.
 *
 * ## Why the finding repeats across a worker's tasks, and why that is right
 *
 * The harvest's unit is the task. An unexplained directory belongs to no task
 * — that is what makes it unexplained — so a worker with three tasks and one
 * stray directory produces the same line in three task harvests.
 *
 * The alternative was considered and rejected: emitting it only on, say, the
 * worker's lexicographically first task would make `pifleet artifacts --task
 * t2` blind to it. A finding whose visibility depends on which task an
 * operator happened to ask about is not a finding, it is a coin flip, and the
 * defect being closed here is precisely a harvest that showed nothing wrong.
 * Repetition is a cost paid in lines; the alternative is paid in silence.
 */
export async function unexplainedOutboxDirs(run: RunPaths, workerId: string): Promise<string[]> {
  const outbox = workerOutboxDir(run.root, workerId);

  let entries: Dirent[];
  try {
    entries = await readdir(outbox, { withFileTypes: true });
  } catch {
    /*
     * No outbox directory at all, or one that cannot be listed.
     *
     * NOT a finding here, and the restraint is deliberate. `materialize.ts`
     * creates this directory for every worker it launches, so its absence
     * means the worker was never materialised — a run that did not start,
     * which is a different and much louder fact than a misnamed directory. The
     * missing-envelope finding in `harvestTask` already covers what an
     * operator needs to know about that task, and inventing a layout complaint
     * on top of it would report the same one fact twice under two headings.
     */
    return [];
  }

  const dispatched = new Set(await dispatchedTaskIds(run));
  if (dispatched.size === 0) return [];

  const exempt = ledgerDirName(run.root, workerId);
  const unexplained = entries
    .filter((e) => e.isDirectory() && e.name !== exempt && !dispatched.has(e.name))
    .map((e) => e.name)
    // Sorted so two harvests of one outbox name the same directories in the
    // same order; `readdir` order is not specified, and with the cap below it
    // would otherwise decide WHICH directories get named.
    .sort();

  if (unexplained.length === 0) return [];

  const named = unexplained.slice(0, MAX_NAMED_UNEXPLAINED_DIRS);
  const out = named.map(
    (name) =>
      `the outbox for worker ${safeForReport(workerId)} holds directory ` +
      `${safeForReport(name)}/, which is not a dispatched task id; nothing inside it was ` +
      `scanned, validated, or swept for credentials`,
  );
  const more = unexplained.length - named.length;
  if (more > 0) {
    out.push(
      `and ${more} further director${more === 1 ? "y" : "ies"} under worker ` +
        `${safeForReport(workerId)}'s outbox that no dispatched task explains; not named`,
    );
  }
  return out;
}
