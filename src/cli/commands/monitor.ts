import type { Command } from "commander";

import { EXIT } from "../../contracts.ts";
import { composeFleet } from "../../monitor/compose.ts";
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
 * ## The poll loop is interim
 *
 * §3.4's three clocks (fast 500 ms, medium 5 s, slow 30 s) live in
 * `src/monitor/clocks.ts`. Until that is wired in, this is a single-rate poll
 * that runs the whole read on every tick, including the `docker ps` and the run
 * walk that belong on the slow clock. The default of 2 s is chosen against the
 * MEASURED cost of one full compose (~380 ms, dominated by the run walk — Q5) so
 * that the loop is never more than a fifth busy; the three-clock scheduler is
 * what allows the fast rate to drop to 500 ms without paying that walk.
 */
export function register(program: Command): void {
  program
    .command("monitor")
    .description("Watch the fleet: runs, workers, containers, git")
    .option("--once", "print one frame and exit")
    .option("--poll <seconds>", "seconds between frames", "2")
    .option("--columns <n>", "frame width; defaults to the terminal's")
    .option("--watch-dir <path>", "repository the git strip watches", process.cwd())
    .action(async (opts: { once?: boolean; poll: string; columns?: string; watchDir: string }) => {
      /*
       * `process.stdout.columns` is `undefined` when stdout is not a terminal —
       * a pipe, a test, a CI log. 100 is the fallback and it is the same number
       * `ink-testing-library` hard-codes, which makes a piped frame comparable
       * to the one the render suite asserts on.
       */
      const columns = Number(opts.columns ?? process.stdout.columns ?? 100);
      const pollMs = Math.max(250, Number(opts.poll) * 1_000);

      const frame = async (): Promise<string[]> =>
        renderFleet(await composeFleet({ watchDir: opts.watchDir, columns }));

      if (opts.once === true) {
        process.stdout.write(`${(await frame()).join("\n")}\n`);
        return;
      }

      let last: string | null = null;
      let stop = false;
      // SIGINT leaves the loop rather than killing the process mid-write, so a
      // half-painted frame never survives on the pane the operator was reading.
      process.on("SIGINT", () => {
        stop = true;
      });

      while (!stop) {
        const next = (await frame()).join("\n");
        if (next !== last) {
          // Clear and home, then paint. Not `console.clear()`, which is a no-op
          // when stdout is not a TTY and would leave a piped monitor appending
          // frames forever.
          process.stdout.write(`\x1b[H\x1b[2J${next}\n`);
          last = next;
        }
        await new Promise((r) => setTimeout(r, pollMs));
      }
      process.exitCode = EXIT.SUCCESS;
    });
}
