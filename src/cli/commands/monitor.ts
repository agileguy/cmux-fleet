import type { Command } from "commander";

import { EXIT } from "../../contracts.ts";
import { CliError } from "../index.ts";
import { monotonicMs } from "../../util/clock.ts";
import {
  FleetClocks,
  containerNameSet,
  driveClocks,
  fleetSources,
} from "../../monitor/clocks.ts";
import { composeFleet, fetchForView, modelFrom } from "../../monitor/compose.ts";
import { never, type FleetModel, type ViewState } from "../../monitor/model.ts";
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
/**
 * The four view names an operator can type, and the selection each needs.
 *
 * ## Why this is a function and not four `if`s in the action handler
 *
 * `ViewState` is a discriminated union that CANNOT represent a worker view
 * with no worker (`model.ts`), which is the property the whole selection model
 * rests on. That guarantee is only worth having if the place where operator
 * input becomes a `ViewState` either produces a valid one or refuses — and a
 * conversion buried in an action handler is reachable by no test without a
 * terminal, which ISC-491 forbids the whole block from requiring. Exported and
 * pure, it is the one function that has to be right and the one a test can
 * actually drive.
 *
 * ## The refusals, and why an ignored flag is one of them
 *
 * A missing selection refuses, obviously. A SUPERFLUOUS one refuses too:
 * `--view history --worker eng-1` names a worker the history view cannot show,
 * and accepting it would print a run list while the operator believed they had
 * asked about `eng-1`. That is the same class of defect as a viewer that shows
 * a stale number confidently — the command did something reasonable and not
 * the thing it was asked for. Refusing costs one retype; accepting costs a
 * wrong belief, and §4.3 already decided which way that trade goes.
 */
export class ViewFlagError extends CliError {
  constructor(message: string) {
    /*
     * A `CliError`, NOT a bare `Error` with `process.exitCode` set beside it.
     * The first version of this did the latter and every refusal below exited
     * **0** — `main` in `../index.ts` ends `await program.parseAsync(argv);
     * return EXIT.SUCCESS;` and that return is assigned over whatever an
     * action left on `process.exitCode`. So a script asking `monitor --view
     * report` with no `--run` got the refusal on stderr and a success code,
     * which is the worst of both. Throwing is the repo's actual convention
     * (`status.ts`, `daemon.ts`, `worktrees.ts`) and the ladder carries it.
     */
    super(message, EXIT.USAGE);
    this.name = "ViewFlagError";
  }
}

export function viewFromFlags(flags: {
  readonly view?: string;
  readonly worker?: string;
  readonly run?: string;
}): ViewState {
  const name = flags.view ?? "fleet";
  const worker = flags.worker;
  const run = flags.run;

  const refuseExtra = (kind: string, allowed: readonly string[]): void => {
    const given = [
      worker === undefined ? null : "--worker",
      run === undefined ? null : "--run",
    ].filter((f): f is string => f !== null);
    const extra = given.filter((f) => !allowed.includes(f));
    if (extra.length > 0) {
      throw new ViewFlagError(
        `--view ${kind} takes ${allowed.length === 0 ? "no selection" : allowed.join(" and ")}; ` +
          `${extra.join(" and ")} would be ignored. Drop ${extra.length === 1 ? "it" : "them"} ` +
          `or pick the view that uses ${extra.length === 1 ? "it" : "them"}.`,
      );
    }
  };

  switch (name) {
    case "fleet":
      refuseExtra("fleet", []);
      return { kind: "fleet" };
    case "history":
      refuseExtra("history", []);
      return { kind: "history" };
    case "worker":
      refuseExtra("worker", ["--worker", "--run"]);
      if (worker === undefined || run === undefined) {
        throw new ViewFlagError(
          "--view worker needs both --worker <id> and --run <id>. A worker view with no " +
            "worker names nothing, which is why the model cannot represent one.",
        );
      }
      return { kind: "worker", runId: run, workerId: worker };
    case "report":
      refuseExtra("report", ["--run"]);
      if (run === undefined) {
        throw new ViewFlagError("--view report needs --run <id>. A report is a report OF a run.");
      }
      return { kind: "report", runId: run };
    default:
      throw new ViewFlagError(
        `unknown view ${JSON.stringify(name)}. The four are: fleet, worker, history, report.`,
      );
  }
}

export function register(program: Command): void {
  program
    .command("monitor")
    .description("Watch the fleet: runs, workers, containers, git")
    .option("--once", "print one frame and exit")
    .option("--poll <seconds>", "seconds between repaints (reads run on their own clocks)", "1")
    .option("--columns <n>", "frame width; defaults to the terminal's")
    .option("--no-colour", "plain text even on a terminal")
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
    .option("--view <name>", "fleet | worker | history | report", "fleet")
    .option("--worker <id>", "worker to show, for --view worker")
    .option("--run <id>", "run to show, for --view worker and --view report")
    .action(async (opts: {
      once?: boolean;
      poll: string;
      columns?: string;
      repo: string;
      colour?: boolean;
      view?: string;
      worker?: string;
      run?: string;
    }) => {
      /*
       * The selection is resolved BEFORE anything is read. A refusal must cost
       * nothing — an operator who typed `--view worker` and forgot `--worker`
       * should not wait out a run walk to be told so, and on the polling path a
       * bad selection must never reach the scheduler at all.
       */
      const view: ViewState = viewFromFlags(opts);
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

      /*
       * Colour when stdout is a terminal, and off when it is not — the
       * `isTTY` convention every well-behaved CLI follows, so a piped or
       * redirected frame is plain text a grep can read. `--no-colour` forces it
       * off for a terminal that renders the palette badly; there is
       * deliberately no flag to force it ON, because the only reason to want
       * escapes in a pipe is to look at them, and `--once` into a terminal
       * already does that.
       */
      const colour = opts.colour !== false && process.stdout.isTTY === true;

      if (opts.once === true) {
        const model = await composeFleet({ watchDir: opts.repo, columns, view });
        process.stdout.write(`${renderFleet(model, { colour }).join("\n")}\n`);
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
          /*
           * The fast clock's input: the workers THE LAST WALK FOUND. A getter
           * for the same reason `containers` is one — the fleet this refreshes
           * is whatever the slow clock last enumerated, and a value would pin
           * it to the first tick forever.
           */
          knownRuns: () => {
            const runs = clocks.snapshot().runs;
            return runs.status === "ok" ? runs.value : [];
          },
        }),
      );

      const driver = driveClocks(clocks, {
        // A read that throws must not take the pane down. It already becomes a
        // failed region; this is for the case that guarantee is wrong.
        onError: (err) => process.stderr.write(`pifleet monitor: ${String(err)}\n`),
      });

      let last: string | null = null;
      let done: (() => void) | null = null;

      /*
       * Views 2-4's payload, refreshed on its own timer and NEVER on the paint.
       *
       * `paint()` is synchronous and runs on the repaint interval; awaiting a
       * run walk or a `collectRunReport` inside it would put those costs on the
       * path §6.3 keeps clear. So the payload is a variable a slower loop
       * replaces, and a frame renders whatever the last completed fetch left —
       * which is exactly the staleness `Region.readAt` already displays, so it
       * is visible rather than hidden.
       *
       * `inFlight` is not an optimisation. `collectRunReport` was measured at
       * 117 ms (Q7) on the largest run on disk today, but that is a number
       * about THIS disk, and a fetch slower than its own interval would
       * otherwise stack one walk on the next until the process fell over.
       */
      let payload = { history: never(), detail: never(), report: never() } as Pick<
        FleetModel,
        "history" | "detail" | "report"
      >;
      let inFlight = false;
      const PAYLOAD_MS = 5_000;

      const refreshPayload = async (): Promise<void> => {
        if (inFlight || view.kind === "fleet") return;
        inFlight = true;
        try {
          payload = await fetchForView(view);
        } catch (err) {
          // Same contract as the scheduler's `onError`: a read that throws
          // must not take the pane down. The regions stay as they were and
          // keep displaying their own age.
          process.stderr.write(`pifleet monitor: ${String(err)}\n`);
        } finally {
          inFlight = false;
        }
      };

      const paint = (): void => {
        const next = renderFleet(
          modelFrom(clocks.snapshot(), {
            view,
            payload,
            // Monotonic for the staleness markers, wall clock for the activity
            // ladder. `model.ts`'s two-clocks note says why they are separate
            // and what swapping them looks like on screen.
            now: monotonicMs(),
            nowEpochMs: Date.now(),
            columns,
          }),
          { colour },
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
      // The payload is fetched BEFORE the first paint for the same reason the
      // clocks are ticked before it: an opening frame of `no data` is true at
      // that instant and indistinguishable, to someone who has just typed the
      // command, from a monitor that cannot see anything.
      await Promise.all([clocks.tick(), refreshPayload()]);
      paint();

      const payloadTimer =
        view.kind === "fleet" ? null : setInterval(() => void refreshPayload(), PAYLOAD_MS);
      payloadTimer?.unref?.();

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
          // The payload timer is cleared beside the painter, not left to
          // `unref` alone. `unref` stops a timer HOLDING the process open; it
          // does not stop it FIRING, so a monitor shutting down on EPIPE would
          // otherwise keep walking the runs root until the loop drained.
          if (payloadTimer !== null) clearInterval(payloadTimer);
          driver.stop();
          resolve();
        };
        process.on("SIGINT", done);
      });
      process.exitCode = EXIT.SUCCESS;
    });
}
