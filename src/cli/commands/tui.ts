/**
 * `pifleet tui --worker <id>` (SRD §3.5, §16 Phase 6): hand that worker's
 * pane to a person; `--leave` hands it back.
 *
 * Presentation plane only, like `attach`. The supervisor, container and RPC
 * stream are untouched — dispatch, steer, abort and harvest keep working
 * while the pane is attended, which is the Phase 6 exit criterion ("Dan takes
 * over a pane mid-task; harvest still succeeds").
 *
 * The backend comes from the worker's `presentation.json`, never from a flag,
 * for the same reason `attach` reads it there: the run already decided which
 * backend it is on, and a flag would let an operator ask cmux to respawn a
 * pane tmux owns.
 *
 * The voided-requirements table is printed AT ENTRY, on purpose. The person
 * about to type is the one who most needs to know which guarantees their
 * keystrokes void, and a table that only ever appears in `report` is read
 * after the damage, not before it.
 *
 * ## A `pane_mode: tui` worker (SRD §3.5, TUI spec item 11)
 *
 * Everything above describes handing over an `rpc` worker's pane. A
 * `pane_mode: tui` worker is the case this command was never written for, and
 * it does not merely need permission — it needs different semantics, because
 * two of the three things "enter" does are wrong for it.
 *
 * **The pane is already the person's, by construction.** `up` creates it
 * running `docker attach` on a container whose Pi is a TUI on a real pty. There
 * is no read-only viewer to take away and nothing to hand over: the pane IS the
 * worker's terminal. So:
 *
 * - **Enter does not respawn.** `attended/mode.ts`'s `interactiveArgv` is
 *   `docker exec -it <container> bash`, and its docblock says exactly why —
 *   "NOT `docker attach`… attaching a human keyboard to a JSONL protocol stream
 *   would corrupt the control plane". That reasoning is about an RPC worker.
 *   Run against a tui worker it does the opposite damage: it REPLACES the
 *   person's window onto Pi with a shell, destroying the one thing the mode
 *   exists to provide. Entry therefore writes the record and leaves the pane
 *   alone, by handing `enterTui` a driver that does nothing. `PaneDriver` is a
 *   narrowed injection seam — the module documents it as one — so this is the
 *   sanctioned way to say "no pane change", not a way around the ordering the
 *   module is built on.
 *
 * - **`--leave` is REFUSED.** There is nowhere to hand the pane back to. The
 *   viewer `leaveTui` respawns (`logs --follow --render`) would detach the only
 *   terminal the worker has, leaving a running container nobody can drive and
 *   no command that re-attaches it — entry is a no-op by the rule above. Worse,
 *   `left_at` asserts a person STOPPED driving; on a pane that is still
 *   `docker attach` they have not, and that is the precise lie
 *   `attended/mode.ts` exists to prevent. Refusing keeps the record in the safe
 *   direction: it can overclaim attendance, never underclaim it.
 *
 * **THE ALTERNATIVE REJECTED: refuse entry too, on the grounds that it is a
 * no-op.** It is not a no-op — it writes the record — and that record is the
 * only thing standing between this mode and the invariant. Refusing would leave
 * a `pane_mode: tui` worker with no command that can ever mark it attended.
 *
 * **NOT CLAIMED, and it is the residual that matters most here.** The record is
 * still only written when an operator RUNS this command. A `pane_mode: tui`
 * worker's pane is attached to a person from the moment `up` creates it, so
 * between `up` and that command a run a person could be typing into presents as
 * unattended. Nothing in this file can close that: the fix is to write the
 * record at `up` time, where the mode is decided, and `cli/commands/up.ts` is
 * outside this phase's edit surface. Stated here rather than left to be
 * discovered, because a half-closed invariant that reads as closed is worse
 * than an open one.
 */

import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot, workerPaths } from "../../run/paths.ts";
import { readPresentation, readWorkerLaunch } from "../../run/state.ts";
import { loadBackend } from "../../backends/registry.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { enterTui, leaveTui, type PaneDriver } from "../../attended/mode.ts";
import { launchPaneMode } from "../../container/interrupt.ts";

/**
 * The driver a `pane_mode: tui` worker's entry uses: it changes no pane.
 *
 * Named and exported rather than written inline at the call site so the thing
 * it asserts is visible to a reader and to a test — that entering attended mode
 * on a worker whose pane is ALREADY a person's `docker attach` must not respawn
 * that pane. See this module's docblock for why respawning it would destroy the
 * mode.
 *
 * `enterTui` still writes the record BEFORE calling this, so the module's
 * ordering guarantee is untouched: the record cannot be missing while the pane
 * is a person's.
 */
export const PANE_ALREADY_ATTENDED: PaneDriver = {
  async attachViewer(): Promise<void> {
    // Deliberately nothing. The pane is the worker's terminal already.
  },
};

/**
 * A worker's pane mode as `up` actually launched it, or `"rpc"` for a worker
 * with no launch record.
 *
 * Exported pure so the routing decision can be probed without a fleet.
 *
 * `launch === null` is the `PIFLEET_PI_COMMAND` double, and it is `rpc`: the
 * double is a plain process with a live supervisor holding a real control
 * socket, and the whole tui mode is about a container's TTY. The supervisor
 * states the same answer from its own side. `abort.ts` originally read the
 * absent record as "no control plane at all" and was wrong for exactly this
 * reason, so the answer is written down rather than re-derived per command.
 */
export function tuiPaneMode(launch: Awaited<ReturnType<typeof readWorkerLaunch>>): "rpc" | "tui" | "unknown" {
  return launch === null ? "rpc" : launchPaneMode(launch);
}

export function register(program: Command): void {
  program
    .command("tui")
    .description("Hand a worker's pane to a person (return it with --leave)")
    .option("-w, --worker <id>", "worker id")
    .option("-r, --run <id>", "run id (defaults to the most recent run)")
    .option("--leave", "return the pane to the read-only viewer")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { worker?: string; run?: string; leave?: boolean; json?: boolean }) => {
      if (opts.worker === undefined || opts.worker.trim() === "") {
        throw new CliError("tui requires --worker <id>", EXIT.USAGE);
      }
      const root = runsRoot();
      const runId = opts.run ?? (await latestRunId(root));
      if (runId === null) {
        throw new CliError("no runs found", EXIT.USAGE);
      }
      const run = runPaths(runId, root);
      const wp = workerPaths(run, opts.worker);

      const presentation = await readPresentation(wp);
      if (presentation === null) {
        throw new CliError(
          `no presentation record for worker ${opts.worker} in run ${runId}`,
          EXIT.USAGE,
        );
      }

      /**
       * `headless` has no pane to hand over, and saying so beats pretending:
       * writing an attended record for a pane that cannot exist would mark a
       * run as human-touched when no hand could have touched it — the inverse
       * of the lie this subsystem prevents, and just as corrosive to trust.
       */
      if (presentation.backend === "headless" || presentation.surface_ref === null) {
        throw new CliError(
          `worker ${opts.worker} has no pane to hand over (backend: ${presentation.backend})`,
          EXIT.BACKEND_UNAVAILABLE,
        );
      }

      /**
       * Which shape of pane this worker has, read off what `up` actually ran
       * rather than off config — `up` resolved the mode in a cwd and
       * environment this process does not share.
       */
      const paneMode = tuiPaneMode(await readWorkerLaunch(wp));
      if (paneMode === "unknown") {
        // The same refusal `planInterrupt` makes, for the same reason: a record
        // whose field and rendered marks disagree names a worker that cannot
        // work, and guessing would either respawn a pane that must not be
        // respawned or leave one that must be.
        throw new CliError(
          `worker ${opts.worker} in run ${runId} has a launch record whose pane mode and argv ` +
            `disagree (--mode rpc and -t) — refusing to guess whether its pane is a viewer or a ` +
            `person's terminal`,
          EXIT.USAGE,
        );
      }
      const alreadyAttended = paneMode === "tui";

      const backend = await loadBackend(presentation.backend);
      const pane = { backend: presentation.backend, id: presentation.surface_ref };
      const ledger = new LedgerWriter(run, `cli-tui-${process.pid}`);

      if (opts.leave === true) {
        if (alreadyAttended) {
          // See the module docblock: there is no viewer to return the pane to,
          // and `left_at` would assert the person stopped driving a terminal
          // they still own.
          throw new CliError(
            `worker ${opts.worker} is pane_mode: tui — its pane IS the worker's terminal, so ` +
              `there is nothing to hand back. Returning it to the read-only viewer would detach ` +
              `the only terminal the container has, and recording left_at would say a person ` +
              `stopped driving a pane they are still attached to. Stop the worker with ` +
              `pifleet abort --worker ${opts.worker} instead.`,
            EXIT.USAGE,
          );
        }
        const record = await leaveTui({
          run,
          workerId: opts.worker,
          backend,
          pane,
          runsRoot: root,
        });
        await ledger.append("tui_left", { worker: opts.worker });
        if (opts.json === true) {
          process.stdout.write(`${JSON.stringify(record)}\n`);
        } else {
          process.stdout.write(
            `${opts.worker} pane returned to the viewer; the run remains marked attended\n`,
          );
        }
        return;
      }

      const record = await enterTui({
        run,
        workerId: opts.worker,
        // The ONE difference between the two modes' entry: a tui worker's pane
        // is not respawned, because it is already the person's `docker attach`.
        backend: alreadyAttended ? PANE_ALREADY_ATTENDED : backend,
        pane,
      });
      await ledger.append("tui_entered", {
        worker: opts.worker,
        detail: {
          // `via` names WHICH operation happened, `abort.ts`'s precedent: both
          // rows say the run is attended and only one of them respawned a pane.
          via: alreadyAttended ? "pane_already_attended" : "respawned_interactive",
          voided: record.voided.map((v) => v.isc),
        },
      });
      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify({ ...record, via: alreadyAttended ? "pane_already_attended" : "respawned_interactive" })}\n`,
        );
        return;
      }
      const lines = alreadyAttended
        ? [
            `${opts.worker} is pane_mode: tui — its pane has been attached to a person since up`,
            `recorded as attended; the pane was NOT changed (it is already docker attach to the worker's TUI)`,
            `${record.voided.length} guarantee(s) are void while a person drives:`,
            ...record.voided.map((v) => `  ${v.isc}: ${v.because}`),
            `there is no --leave for this worker: the pane is the worker's only terminal`,
          ]
        : [
            `${opts.worker} pane is now attended (interactive shell in its container)`,
            `${record.voided.length} guarantee(s) are void while a person drives:`,
            ...record.voided.map((v) => `  ${v.isc}: ${v.because}`),
            `hand it back with: pifleet tui --worker ${opts.worker} --leave`,
          ];
      process.stdout.write(`${lines.join("\n")}\n`);
    });
}
