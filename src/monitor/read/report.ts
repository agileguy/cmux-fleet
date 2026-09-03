/**
 * View 4: one run's report, as the EXISTING renderer already writes it
 * (SRD-FLEET-MONITOR §6.2 View 4, §2.5, §5.3, D10, §9 Q7).
 *
 * ## This module formats nothing, and that is the whole of its design
 *
 * `renderRunReport` (`report/render.ts:27-140`) already fixes the order those
 * facts must be read in and argues for it: attended first (`:37-43`), security
 * second (`:59-66`), totals third. It also owns wording that is load-bearing
 * rather than decorative — a clean pre-check must read *"would merge cleanly …
 * as of this check — **NOT merged**"* (`render.ts:194-199`), and a clean
 * escape-watch names the number of containers actually armed rather than saying
 * "no attempts" (`:118-132`). Each of those sentences was written because the
 * shorter version was misread.
 *
 * **A second renderer of one fact is the ISC-345 hazard, and a report is the
 * worst place for it.** `harvest/layout.ts:89-108` states the finding: *"two
 * readers of one fact, written independently, is how a value-reader goes blind
 * while its sibling keeps working"*. Two report renderers would not go blind —
 * they would DISAGREE, in a pane and on a terminal, about whether a branch
 * merges. So this module produces `readonly string[]` by splitting the existing
 * renderer's output on newlines, and there is no other expression in it that
 * puts a fact into a sentence.
 *
 * ## The harness surface travels with the report, and dropping it would regrade
 *
 * `pifleet report` resolves `harness.patterns` before collecting (ISC-232,
 * `cli/commands/report.ts:38-41`) because *"a run graded one way by one command
 * and another way by the other is not two views of a run, it is a bug with two
 * outputs"*. A monitor that skipped that step would be the third output: the
 * same run, graded against the built-in defaults in the pane and against the
 * run's own recorded patterns on the terminal, with nothing on either surface
 * saying which. So the resolution is made here too, from the same function, and
 * the notes are assembled in the same order the command assembles them
 * (`report.ts:63`) — which is what makes the byte-for-byte equality this
 * module's test asserts possible at all.
 *
 * ## Q7 IS ANSWERED, AND §2.5 WAS WRONG IN THE SAFE DIRECTION
 *
 * §2.5 called this path *"seconds, not milliseconds"* without measuring it.
 * §9 Q7 measured 117 ms and 139 ms including ~70 ms of `bun` startup.
 * **Re-measured on the current runs root, 2026-09-02, in-process and therefore
 * without the interpreter's startup: 36 ms median (n=5, min 34, max 65) on the
 * run holding the largest event log — 24.7 MB, `2026-08-30T23-41-07Z-1b0a` —
 * and 36 ms median (min 36, max 38) on the busiest run, `…T06-37-44Z-b49e`,
 * which has 3 tasks. End to end through the CLI the same report is 170 ms wall,
 * three times running, which is the interpreter and `commander`, not this work.
 * Both runs' reports carry a non-empty `merge` array, so `git merge-tree` really
 * executed and is not being skipped.**
 *
 * **THE CAVEAT IS THE HONEST HALF AND IS REPEATED HERE RATHER THAN LEFT IN THE
 * SRD.** No run on this disk has more than 3 tasks or more than 1 merge entry,
 * and §2.5's concern was per-(worker, branch) and per-task FAN-OUT. So this
 * measurement bounds the cost for runs of the shape that actually occur here and
 * establishes nothing about a run with 20 tasks across 6 workers on real
 * branches. **That is why 36 ms does not earn this a clock.** §5.3 defers *"any
 * use of `collectRunReport` on the fast clock"*, and the deferral is about the
 * unbounded case, not about the measured one — a read that is cheap on the
 * fleet you have and unbounded on the fleet you might have belongs behind a
 * keystroke, where its cost is one operator's wait rather than a permanent
 * duty cycle.
 *
 * ## The one criterion this module deliberately fails to satisfy from `ROOTS`
 *
 * `test/unit/monitor-readonly.test.ts` asserts that no monitor module names
 * `collectRunReport` or imports from `harvest/`. **This module does both, and
 * ISC-473 says so in its own words: the monitor never produces a verdict
 * "outside view 4".** This IS view 4. The exemption is named in that test rather
 * than achieved by keeping this file out of its `ROOTS` list, because a file
 * absent from the walk is unguarded on every other axis too.
 */

import { monotonicMs } from "../../util/clock.ts";
import { failed, ok, type Region } from "../model.ts";
import { runPaths, runsRoot } from "../../run/paths.ts";
import { resolveHarnessPatterns } from "../../harvest/patterns.ts";
import { collectRunReport } from "../../report/collect.ts";
import { renderRunReport } from "../../report/render.ts";

export interface ReadRunReportOptions {
  /** The runs root. Defaults to `runsRoot()`. */
  readonly root?: string;
  /** MONOTONIC, for `readAt`. */
  readonly now?: () => number;
}

/**
 * One run's report, as lines.
 *
 * ## Why a `failed` region is reachable at all when `collectRunReport` degrades
 *
 * `collect.ts:13-16` is explicit that it degrades rather than throwing, because
 * *"`report` is what an operator runs when things went WRONG"*, and its
 * findings arrive as `notes` which the renderer prints inline. So the ordinary
 * bad run produces an `ok` region full of bad news, which is correct.
 *
 * The `try` is still here and it is not defensive padding. `resolveHarnessPatterns`
 * loads a config file and `loadConfig` throws on one it cannot parse; a run
 * directory that has been removed between the keystroke and the read throws;
 * and `collectRunReport`'s degradation is a stance rather than a proof. A view
 * that took the process down on any of those would take the fleet view with it,
 * which §6.1 names as the cost of merging two panes into one process and the
 * thing every region boundary in this design exists to contain.
 *
 * `readAt` is stamped AFTER the work, per `model.ts:25-28`. On a 36 ms read
 * that is a small error; the rule is kept anyway, because a stamping convention
 * that holds only where it is cheap is not a convention.
 */
export async function readRunReport(
  runId: string,
  opts?: ReadRunReportOptions,
): Promise<Region<readonly string[]>> {
  const now = opts?.now ?? monotonicMs;
  const run = runPaths(runId, opts?.root ?? runsRoot());

  try {
    const harness = await resolveHarnessPatterns(run);
    const collected = await collectRunReport(run, { harnessPatterns: harness.patterns });
    /*
     * The SAME assembly `cli/commands/report.ts:63` performs, in the same
     * order: config warnings, then the surface line, then collection notes.
     * Not a copy for convenience — the order is what the renderer prints, so
     * reordering here would produce a report that says the same things in a
     * different sequence from the command, which is a difference nobody would
     * notice and everybody would have to reconcile.
     */
    const notes = [...harness.warnings, harness.surface, ...collected.notes];
    const text = renderRunReport(
      collected.report,
      notes,
      collected.attended,
      collected.attendedUnverified,
      collected.stagedWorkers,
    );
    /*
     * `split("\n")` and nothing else — no trim, no filter, no re-wrap.
     * `renderRunReport` ends with a newline, so the last element is `""`, and
     * that empty string is KEPT: dropping it would make this array not quite
     * the renderer's output, which is the one property the module has. A
     * display layer that does not want a trailing blank line can drop it where
     * it paints, where the decision is visible.
     */
    return ok(text.split("\n"), now());
  } catch (err) {
    return failed(`report for run ${runId} failed: ${firstLine(err)}`, now());
  }
}

/** One line of diagnosis — a region reason is one cell (`read/worker.ts`). */
function firstLine(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}
