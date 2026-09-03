import type { Command } from "commander";

import { EXIT } from "../../contracts.ts";
import { monotonicMs } from "../../util/clock.ts";
import {
  FleetClocks,
  containerNameSet,
  driveClocks,
  fleetSources,
} from "../../monitor/clocks.ts";
import { composeFleet, modelFrom } from "../../monitor/compose.ts";
import { renderFleet } from "../../monitor/render.ts";

/**
 * `pifleet monitor` — the fleet viewer (SRD-FLEET-MONITOR §6, ISC-488).
 *
 * ## Read-only, and the proof is in what this file cannot reach
 *
 * D3/D15 and ISC-468: the monitor's transitive import list contains no control
 * socket, no ledger writer and no dispatching command. This module is the ONE
 * place that could break that, because it is the only monitor file `src/cli`
 * loads, so it imports exactly two things from the monitor — `composeFleet` and
 * `renderFleet` — and nothing else from anywhere. A future `--steer` flag here
 * would be a one-line change that silently converts a viewer into a control
 * surface; `test/unit/monitor-readonly.test.ts` is what stops it.
 *
 * ## Why the redraw is conditional, and why that is not an optimisation
 *
 * The frame is repainted only when its lines DIFFER from the last ones. That is
 * `redrawOnChange`'s behaviour (`operations-plan.ts:640-660`) preserved through
 * the rewrite, and it was not adopted here for cost — Ink renders in ~2 ms — but
 * for Q10: a pane that clears and repaints an identical frame every 500 ms
 * flashes, and an operator reads flashing as activity. Repainting only on change
 * means a quiet fleet is a still pane, which is the correct signal.
 *
 * The comparison is over `string[]`, which is only possible because D2's seam
 * hands back lines rather than a component tree — the same property every test
 * in this design depends on, used here in production.
 *
 * ## Three clocks, one timer, and a paint rate that is neither
 *
 * The reads run on `FleetClocks` (§3.4, D4, D7): the 1777 ms run walk on the
 * 30 s clock, `docker ps` beside it, the git strip and the cheap run-name scan
 * on 5 s. `driveClocks` turns one 500 ms timer into all three, because 500
 * divides 5000 divides 30000 and three independent intervals would drift.
 *
 * **Painting is separate from reading and runs on its own interval.** A frame
 * is a pure function of a snapshot, so painting when nothing was re-read costs
 * one render and produces an identical frame, which the conditional redraw then
 * suppresses. What it buys is that the AGES move: `as of 4s` becoming `as of
 * 9s` is the staleness signal §6.4 requires, and a pane that only repainted
 * when a read completed would freeze that number for thirty seconds and look
 * exactly like a monitor that had stopped.
 *
 * `--once` does NOT use the scheduler. A single frame wants every region read
 * now, and a scheduler's first tick reads them all anyway — but it would then
 * report the run walk as `readAt` = the walk's end and the git strip as its
 * own, which is correct and pointless for a one-shot. `composeFleet` reads
 * everything against one moment, which is what a snapshot on stdout means.
 */
export function register(program: Command): void {
  program
    .command("monitor")
    .description("Watch the fleet: runs, workers, containers, git")
    .option("--once", "print one frame and exit")
    .option("--poll <seconds>", "seconds between repaints (reads run on their own clocks)", "1")
    .option("--columns <n>", "frame width; defaults to the terminal's")
    /*
     * `--repo`, NOT `--watch-dir`, and the rename is forced by a criterion
     * rather than by taste.
     *
     * ISC-493 requires the console's `watch(1)` prohibition to survive the pane
     * merge with its subject restated, and that assertion is written as
     * `expect(cmd).not.toMatch(/\bwatch\b/)` — a deliberately blunt tripwire
     * for a MEASURED host fact: macOS ships no `watch(1)`, so the obvious way
     * to write a refreshing pane fails on tick one with `command not found`,
     * leaving a dead pane that looks configured. `--watch-dir` in the pane
     * command matches that pattern (`-` is a word boundary), so keeping the
     * flag would have meant loosening the tripwire to a narrower regex on
     * behalf of a flag name. Weakening a guard to accommodate a spelling is the
     * wrong trade; `--repo` is also the more accurate name.
     */
    .option("--repo <path>", "repository the git strip reports on", process.cwd())
    .action(async (opts: { once?: boolean; poll: string; columns?: string; repo: string }) => {
      /*
       * `process.stdout.columns` is `undefined` when stdout is not a terminal —
       * a pipe, a test, a CI log. 100 is the fallback and it is the same number
       * `ink-testing-library` hard-codes, which makes a piped frame comparable
       * to the one the render suite asserts on.
       */
      const columns = Number(opts.columns ?? process.stdout.columns ?? 100);
      // The PAINT interval, not a read interval — the reads are on their own
      // three clocks. See the header.
      const pollMs = Math.max(250, Number(opts.poll) * 1_000);

      if (opts.once === true) {
        const model = await composeFleet({ watchDir: opts.repo, columns });
        process.stdout.write(`${renderFleet(model).join("\n")}\n`);
        return;
      }

      const clocks: FleetClocks<ReturnType<typeof fleetSources>> = new FleetClocks(
        fleetSources({
          watchDir: opts.repo,
          /*
           * A GETTER, closing over the scheduler's own snapshot. The container
           * set feeds the worker reader's `containerPresent`, and both live on
           * the same scheduler — passing a value here would freeze the first
           * tick's answer for the life of the process, so every container that
           * later stopped would keep rendering `up`.
           */
          containers: () => containerNameSet(clocks.snapshot().containers),
        }),
      );

      const driver = driveClocks(clocks, {
        // A read that throws must not take the pane down. It already becomes a
        // failed region; this is for the case that guarantee is wrong.
        onError: (err) => process.stderr.write(`pifleet monitor: ${String(err)}\n`),
      });

      let last: string | null = null;
      let done: (() => void) | null = null;

      const paint = (): void => {
        const next = renderFleet(
          modelFrom(clocks.snapshot(), {
            // Monotonic for the staleness markers, wall clock for the activity
            // ladder. `model.ts`'s two-clocks note says why they are separate
            // and what swapping them looks like on screen.
            now: monotonicMs(),
            nowEpochMs: Date.now(),
            columns,
          }),
        ).join("\n");
        if (next === last) return;
        try {
          // Clear and home, then paint. Not `console.clear()`, which is a no-op
          // when stdout is not a TTY and would leave a piped monitor appending
          // frames forever.
          process.stdout.write(`\x1b[H\x1b[2J${next}\n`);
        } catch (err) {
          // The synchronous half. See `stdout.on("error")` below for why this
          // alone is not enough, and why both are needed.
          if ((err as NodeJS.ErrnoException)?.code !== "EPIPE") throw err;
          done?.();
          return;
        }
        last = next;
      };

      // One tick before the first paint, so the opening frame is a fleet rather
      // than four `never` regions reading `no data` — which is TRUE at that
      // instant and indistinguishable, to someone who has just started the
      // command, from a monitor that cannot see anything.
      await clocks.tick();
      paint();

      const painter = setInterval(paint, pollMs);
      await new Promise<void>((resolve) => {
        // Stop the clocks and the painter before resolving, so no frame is
        // half-written when the process leaves and the pane keeps the last
        // complete one. Shared by SIGINT and by the EPIPE path above, because
        // "the reader went away" and "the operator pressed ctrl-C" are the same
        // ending and must not have two teardowns that can drift apart.
        let stopped = false;
        /*
         * EPIPE IS A NORMAL ENDING, NOT A CRASH — and it arrives ASYNCHRONOUSLY,
         * which is the part that cost a ten-minute hang to learn.
         *
         * `pifleet monitor | head -3` closes the pipe after three lines; a pane
         * the operator closes does the same. The obvious guard is a `try/catch`
         * around the write, and it is wrong on its own: Bun does not throw at
         * the call site for a broken pipe on a piped stdout. It emits `error` on
         * the stream. With only the catch, the failure printed `EPIPE: broken
         * pipe` to stderr once per paint while the painter carried on writing to
         * a descriptor nobody held — a process that never exits, which is worse
         * than the crash it replaced because nothing reports it.
         *
         * Both are kept because the two paths are real: a synchronous throw on
         * some stream types, an `error` event on others, and which one a given
         * stdout produces is not a thing this command should have to know.
         *
         * Any other error is re-thrown. A full disk is not a reader who left.
         */
        process.stdout.on("error", (err: NodeJS.ErrnoException) => {
          if (err?.code !== "EPIPE") throw err;
          done?.();
        });
        done = () => {
          if (stopped) return;
          stopped = true;
          clearInterval(painter);
          driver.stop();
          resolve();
        };
        process.on("SIGINT", done);
      });
      process.exitCode = EXIT.SUCCESS;
    });
}
