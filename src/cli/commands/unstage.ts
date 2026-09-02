/**
 * `pifleet unstage --task <id>` (SRD-TUI-DISPATCH §9 Q8, ISC-457): release a
 * staged epoch that nobody triggered, returning the worker to idle.
 *
 * ## Why this command exists at all
 *
 * §9 Q8 is the one open question the SRD calls BLOCKING, and the sentence it
 * blocks on is short: `EpochManager.allocate` refuses while an epoch is live,
 * so a staged dispatch takes the worker out of service until something settles
 * it — and on the staged route nothing will, because settling requires a turn
 * and a turn requires a keypress. Without this verb the operator's first
 * mis-staged task ends the worker's usefulness for the run. "A design that can
 * stage but not un-stage is a worse seat than the one it replaces" is the
 * SRD's own phrasing, and this file is the answer to it.
 *
 * ## THIS IS NOT `abort`, AND THE DIFFERENCE IS THE WORKER'S LIFE
 *
 * The two words are near-synonyms in English and name opposite outcomes here,
 * so the distinction is stated in the `--description` an operator reads at
 * `pifleet --help`, in the success line this command prints, and here.
 *
 * `pifleet abort` on a `tui` worker does not cancel a turn. `planInterrupt`
 * routes it to `docker kill --signal=INT`, because a `tui` worker is launched
 * without `--mode rpc` and the supervisor holds none of its three streams, so
 * there is no abort RPC to send. `src/container/interrupt.ts` carries the
 * measurement: the entrypoint's signal trap turns that into a graceful STOP of
 * the worker. The container ends. `src/attended/voided.ts`'s ISC-81 row says so
 * in the table the operator is shown at entry.
 *
 * `unstage` releases the EPOCH and leaves everything else standing. The
 * supervisor is untouched, the container keeps running, the person at the
 * adopted terminal does not lose their session, and the worker is immediately
 * stageable again. An operator who staged the wrong brief wants this one; an
 * operator whose agent is off doing something harmful wants the other.
 *
 * **Nothing here modifies `abort`.** The two verbs are deliberately separate
 * commands with separate refusals rather than a flag on one, because a flag
 * would let the wrong half of that pair be reached by a typo.
 *
 * ## What it does NOT do
 *
 * - **It does not settle.** ISC-457 spells out why: a settled task pushes a
 *   `completed` row, and a task that never ran did not complete. `cancel`
 *   deletes the attempt from the fence's `attempts` map instead, which is what
 *   makes a LATER DIFFERENT attempt against the same `task_id` allocate rather
 *   than meet `already_completed`. That property is `EpochManager.cancel`'s and
 *   is tested there; what this command is responsible for is reaching it.
 * - **It does not clean up the durable writes the stage made.** The drop at
 *   `/policy/dispatch` and the inbox record survive, and that is not an
 *   oversight: the inbox record is what `wait` and the harvest key on, and
 *   deleting it would erase the evidence that the task was ever dispatched.
 *   The supervisor clears the two that would MISLEAD — `/policy/task` back to
 *   `(null, 0)`, so an operator who keeps typing at that terminal does not
 *   stamp every gated verb with a task that never ran, and `staged_task_id`, so
 *   `status` stops reporting a worker awaiting a keypress.
 * - **It does not verify the terminal.** Staging refuses when the adopted
 *   terminal is gone (§6.6) because a staged task nobody can trigger is worth
 *   refusing loudly. Releasing one has the opposite polarity: a dead terminal
 *   is the strongest possible reason to want the epoch back, and a liveness
 *   precondition here would make the worker permanently unrecoverable in
 *   exactly the case the operator most needs it.
 */

import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { controlCall } from "../../supervisor/launch.ts";
import { requireLiveWorker, resolveRunPaths } from "../worker-preflight.ts";
import { inboxTaskPath } from "../../run/paths.ts";

/**
 * The supervisor answers from memory — `cancel` is a fence mutation and two
 * small writes — so this is patience for a process mid-GC or mid-settle rather
 * than for the work itself. Same number as `abort`'s, for the same reason.
 */
const UNSTAGE_TIMEOUT_MS = 10_000;

/**
 * The staged task's inbox record names its worker, which is what makes
 * `--worker` optional.
 *
 * The derivation is `wait.ts`'s `workerFor`, deliberately: that function is how
 * every other file-driven verb answers "whose task is this", and a second
 * spelling would be a second thing to keep correct. It is copied rather than
 * imported because `wait.ts` closes it over its own `run`, and exporting it
 * would widen that module's surface for one caller.
 *
 * `null` on anything unreadable — a missing file, a truncated one, a record
 * with no `worker` — and the caller turns that into a refusal that asks for
 * `--worker` rather than guessing. A guess here aims a cancel at the wrong
 * worker, where it either refuses `no_live_epoch` (harmless, confusing) or, on
 * a worker that happens to hold a matching live attempt, releases the wrong
 * epoch.
 */
async function workerFromInbox(
  inboxPath: string,
): Promise<string | null> {
  try {
    const envelope = JSON.parse(await Bun.file(inboxPath).text()) as { worker?: unknown };
    return typeof envelope.worker === "string" && envelope.worker !== "" ? envelope.worker : null;
  } catch {
    return null;
  }
}

/**
 * The attempt id, spelled the way the stage spelled it.
 *
 * `stageForAdoptedTerminal` sends `attempt_id: String(envelope.attempt)`, and
 * `EpochManager.cancel` refuses unless the pair matches the live epoch exactly.
 * So this reads the attempt off the same inbox record and applies the same
 * `String(...)`, rather than accepting one on the command line: an operator
 * asked to supply an attempt id would have to know that the wire form is the
 * decimal spelling of a number the envelope calls `attempt`, and getting it
 * wrong produces `not_the_live_attempt` — a refusal that reads like a race and
 * is actually a typo.
 */
async function attemptFromInbox(inboxPath: string): Promise<string | null> {
  try {
    const envelope = JSON.parse(await Bun.file(inboxPath).text()) as { attempt?: unknown };
    return typeof envelope.attempt === "number" ? String(envelope.attempt) : null;
  } catch {
    return null;
  }
}

export function register(program: Command): void {
  program
    .command("unstage")
    .description(
      "Release a staged-but-untriggered epoch, returning the worker to idle " +
        "(NOT abort — abort on a tui worker sends SIGINT and stops the worker)",
    )
    .option("-t, --task <id>", "staged task id")
    .option("-w, --worker <id>", "worker id (derived from the task's inbox record when omitted)")
    .option("-r, --run <id>", "run id (defaults to the most recent run)")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { task?: string; worker?: string; run?: string; json?: boolean }) => {
      if (opts.task === undefined || opts.task.trim() === "") {
        throw new CliError("unstage requires --task <id>", EXIT.USAGE);
      }
      const taskId = opts.task.trim();
      const run = await resolveRunPaths(opts.run);
      const inboxPath = inboxTaskPath(run, taskId);

      const worker = opts.worker ?? (await workerFromInbox(inboxPath));
      if (worker === null) {
        throw new CliError(
          `cannot tell which worker holds ${taskId} in run ${run.runId}: ` +
            `no readable inbox record at ${inboxPath}. Pass --worker <id>`,
          EXIT.USAGE,
        );
      }

      const attemptId = await attemptFromInbox(inboxPath);
      if (attemptId === null) {
        throw new CliError(
          `cannot read the attempt id for ${taskId} from ${inboxPath}; ` +
            `the fence refuses a cancel that does not name the live attempt exactly`,
          EXIT.USAGE,
        );
      }

      // Liveness BEFORE the socket, exactly as `abort` does it: a typo'd worker
      // and a dead one refuse connect identically, and only the state file can
      // tell 2 from 6.
      await requireLiveWorker(run, worker);

      let reply: Record<string, unknown>;
      try {
        reply = await controlCall(
          run,
          worker,
          { cmd: "unstage", task_id: taskId, attempt_id: attemptId },
          { timeoutMs: UNSTAGE_TIMEOUT_MS },
        );
      } catch (err) {
        throw new CliError(
          `worker ${worker} in run ${run.runId} is unreachable: ${String(err)}`,
          EXIT.WORKER_DIED,
        );
      }

      /**
       * The supervisor's OWN sentence, surfaced verbatim.
       *
       * `unstageRefusalMessage` writes one per arm and each sends the operator
       * somewhere different — `no_live_epoch` means there is nothing to
       * release, `not_the_live_attempt` means they are holding a stale view of
       * the fence, `already_started` means the turn is running and the verb
       * they want is `abort`. Reconstructing them here would be a second
       * spelling that drifts the first time the allocator gains an arm, and the
       * `already_started` sentence in particular is the one place the CLI tells
       * an operator to use the OTHER verb.
       */
      if (reply["ok"] !== true) {
        const error =
          typeof reply["error"] === "string"
            ? reply["error"]
            : `worker ${worker} refused to unstage ${taskId}: ` +
              `${typeof reply["reason"] === "string" ? reply["reason"] : "unknown"}`;
        throw new CliError(error, EXIT.USAGE);
      }
      const epoch = typeof reply["epoch"] === "number" ? reply["epoch"] : 0;

      // The supervisor's `stage_cancelled` row records the release; this one
      // records WHO asked, which the supervisor cannot know — the same split
      // `abort` makes between `abort_requested` and `abort_sent`.
      const ledger = new LedgerWriter(run, `cli-unstage-${process.pid}`);
      await ledger.append("unstage_sent", {
        worker,
        task_id: taskId,
        epoch,
        detail: { attempt_id: attemptId },
      });

      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify({
            run_id: run.runId,
            worker,
            task_id: taskId,
            attempt_id: attemptId,
            epoch,
            released: true,
            // Stated as a FIELD and not only in prose: a caller deciding
            // whether to look for a result must be able to read "there is no
            // result" off the JSON without parsing a sentence.
            settled: false,
          })}\n`,
        );
      } else {
        process.stdout.write(`released epoch ${epoch} on worker ${worker}\n`);
        // The second line is the whole difference between this verb and a
        // settle, and it is printed every time rather than only on a flag: an
        // operator who reads only the first line has been told a number and
        // nothing about whether to go looking for a result.
        process.stdout.write(
          `${taskId} never ran, so nothing was settled — no task record was written ` +
            `and no verdict exists. The worker is idle and stageable again.\n`,
        );
      }
    });
}
