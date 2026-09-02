/**
 * `up --attach-here` — the pane pifleet did not create.
 *
 * ## The shape SRD §3.5 was missing
 *
 * §3.5 knew two: **pifleet owns the pane** (`cmux`/`tmux` create it and run
 * `docker attach` in it) and **there is no pane** (`headless`). The operations
 * console is a third, and it is the one an operator actually sits in front of:
 * a terminal already exists, cmux made it, and pifleet is simply not the one
 * that made it.
 *
 * On that surface both settings are individually right — `--backend headless`
 * because the console must not have windows opening under it, and
 * `pane_mode: tui` because the point is Pi's own interface — and
 * `assertTuiBackendPossible` refused them together. The guard was not wrong;
 * its premise was. **"headless" had been standing in for "no pane exists",**
 * and those stopped being the same statement the moment a person ran `up`
 * inside a pane of their own.
 *
 * ## What adoption is, stated as what it forfeits
 *
 * The caller's terminal becomes the worker's pane for as long as the attach
 * lasts. pifleet gains no ability it did not have: there is no surface id, so
 * nothing can send bytes to this pane later, and `dispatch` still refuses the
 * worker with "a tui worker's prompt has nowhere to go". **That refusal is
 * correct here rather than a gap to route around — the person at the keyboard
 * IS the dispatcher.** Adoption buys one thing: the run is honestly recorded
 * as attended, by a terminal that really is attached.
 *
 * ## Why the guard is separate from `assertTuiBackendPossible`
 *
 * They answer different questions and fail for different reasons. That one
 * asks "can a tui worker exist on this backend at all"; this one asks "can
 * THIS process hand over THIS terminal". Folding them together would produce
 * one refusal that has to explain four unrelated preconditions, and — the
 * reason that matters — a single boolean cannot be reddened one clause at a
 * time by a mutation.
 */

import { workerContainerName } from "../run/paths.ts";
import { DETACH_KEYS } from "./mode.ts";

/**
 * Why the attach is a bare argv here and a shell wrapper in `attachArgv`.
 *
 * `attachArgv` polls `docker inspect` before attaching because a backend pane
 * is created BEFORE the container exists — the pane would otherwise race the
 * launch and die on "No such container". This path runs after `up` has waited
 * for the fleet to report idle, so the container is not merely created but
 * running and answering. A wait loop here would be ceremony that can only
 * ever succeed on its first iteration, and `sh -c` between this process and
 * docker would put a second owner on a terminal §162 says has exactly one.
 */
export function adoptedAttachArgv(runId: string, workerId: string): string[] {
  return [
    "docker",
    "attach",
    `--detach-keys=${DETACH_KEYS}`,
    workerContainerName(runId, workerId),
  ];
}

/** Every reason a terminal cannot be handed to a worker, in one place. */
export type AdoptRefusal =
  | { kind: "no_tui_worker" }
  | { kind: "many_tui_workers"; workers: readonly string[] }
  | { kind: "backend_owns_panes"; backend: string; source: string }
  | { kind: "not_a_terminal"; stream: "stdin" | "stdout" };

/**
 * Decide whether this process may hand its terminal to a tui worker.
 *
 * Pure and returning a REASON rather than a boolean, so the caller renders one
 * message and every clause can be reddened on its own. Returns `null` when
 * adoption is possible.
 *
 * The four refusals, and why each is a refusal rather than a warning:
 *
 *  - **No tui worker.** `--attach-here` on an rpc-only run has nothing to
 *    attach to. Silently ignoring it would leave an operator watching a log
 *    tail and believing they were looking at Pi.
 *  - **More than one.** A process has one terminal. Attaching to the first of
 *    three and calling the run attended would OVERCLAIM for the other two,
 *    which is the one direction `attended/mode.ts` exists to make impossible.
 *  - **A backend that owns panes.** `--backend cmux` with `--attach-here` is a
 *    contradiction: pifleet would create a pane running `docker attach` AND
 *    this terminal would attach to the same container. Two readers on one pty
 *    is §162's constraint violated by a flag combination.
 *  - **Not a terminal.** `docker attach` onto a pipe produces a worker
 *    rendering ANSI into a file nobody reads. Both streams are checked because
 *    a TUI needs to read keys and write frames, and either half alone is a
 *    half-usable pane that looks like a working one.
 */
export function adoptRefusal(args: {
  tuiWorkers: readonly string[];
  backendKind: string;
  backendSource: string;
  stdinIsTty: boolean;
  stdoutIsTty: boolean;
}): AdoptRefusal | null {
  if (args.tuiWorkers.length === 0) return { kind: "no_tui_worker" };
  if (args.tuiWorkers.length > 1) {
    return { kind: "many_tui_workers", workers: args.tuiWorkers };
  }
  if (args.backendKind !== "headless") {
    return {
      kind: "backend_owns_panes",
      backend: args.backendKind,
      source: args.backendSource,
    };
  }
  if (!args.stdinIsTty) return { kind: "not_a_terminal", stream: "stdin" };
  if (!args.stdoutIsTty) return { kind: "not_a_terminal", stream: "stdout" };
  return null;
}

/** The operator-facing sentence for each refusal. */
export function adoptRefusalMessage(r: AdoptRefusal): string {
  switch (r.kind) {
    case "no_tui_worker":
      return (
        `--attach-here needs a worker to attach to, and no worker in this run resolves to ` +
        `pane_mode: tui. Set pane_mode: tui on the worker you meant, or drop the flag.`
      );
    case "many_tui_workers":
      return (
        `--attach-here can hand over ONE terminal and this run has ${r.workers.length} tui ` +
        `workers (${r.workers.join(", ")}). Narrow it with --workers <id>, or run them on ` +
        `--backend cmux so each gets a pane of its own.`
      );
    case "backend_owns_panes":
      return (
        `--attach-here is for a pane pifleet did not create, but this run's backend is ` +
        `${r.backend} — chosen by ${r.source} — and that backend creates the pane itself and ` +
        `runs docker attach in it. Two terminals on one pty is exactly what a TUI cannot ` +
        `have. Drop --attach-here, or pass --backend headless to keep this terminal.`
      );
    case "not_a_terminal":
      return (
        `--attach-here hands this process's terminal to the worker, and its ${r.stream} is ` +
        `not a terminal. Attaching anyway would point Pi's interface at a pipe: it would ` +
        `render frames nobody sees and read keys nobody types. Run it from a real terminal.`
      );
  }
}

// ---------------------------------------------------------------------------
// Is the adopted terminal still there? (SRD-TUI-DISPATCH D9)
// ---------------------------------------------------------------------------

/** Why a staged dispatch cannot be delivered to this worker's terminal. */
export type TerminalRefusal =
  | { kind: "never_recorded" }
  | { kind: "attach_gone"; pid: number }
  | { kind: "pid_reused"; pid: number; recorded: string; observed: string };

/**
 * Decide whether the recorded attach child is still the process that was
 * recorded. PURE — the `ps` read is the caller's, and that separation is what
 * makes every arm of this testable without a process to kill.
 *
 * `observed` is what `processStartTime(recorded.pid)` returned: `null` for
 * "affirmatively no such process", a string for one that exists.
 *
 * ## The three answers are three different sentences
 *
 * They are separated rather than collapsed into a boolean because they send an
 * operator to three different places. `never_recorded` means the capture failed
 * at `up` and nothing is wrong with the terminal. `attach_gone` means they
 * detached — the ordinary case, and the remedy is one command. `pid_reused`
 * means the number was handed to a stranger, which is the case a bare-pid check
 * would have PASSED, and it is the reason this compares the pair.
 *
 * ## Why the pair and not the pid
 *
 * `up.ts` already says it about the supervisor: *"the number outlives the
 * process and the kernel hands it out again."* The window here is much wider
 * than the launcher's — an adopted terminal lives for as long as a person sits
 * at it, and the record is checked minutes or hours later — so the reuse this
 * guards against is not a theoretical one. Same comparison as ISC-144's
 * run-dir lease, deliberately: one identity rule, one spelling.
 *
 * **WHAT IT CANNOT SEE, and this must not be described as more than it is:** a
 * re-attach from elsewhere, a pane respawned onto a different program, and a
 * second concurrent attach all leave a live pid with a matching start time.
 * The host has no mechanism this project has found to enumerate a container's
 * attached clients, so this is a courtesy that catches the two ordinary
 * failures rather than a control that establishes exclusivity.
 */
export function terminalRefusal(
  recorded: { pid: number; started: string } | null,
  observed: string | null,
): TerminalRefusal | null {
  if (recorded === null) return { kind: "never_recorded" };
  if (observed === null) return { kind: "attach_gone", pid: recorded.pid };
  if (observed !== recorded.started) {
    return { kind: "pid_reused", pid: recorded.pid, recorded: recorded.started, observed };
  }
  return null;
}

/**
 * The operator-facing sentence, and every arm ends in the REMEDY.
 *
 * A refusal that only states the fact leaves the operator holding a staged task
 * they cannot deliver and no idea what to do next, which is the failure mode
 * this whole refusal exists to replace — discovering an untriggerable task
 * later beats being told about it now only if being told comes with the fix.
 */
export function terminalRefusalMessage(worker: string, r: TerminalRefusal): string {
  switch (r.kind) {
    case "never_recorded":
      return (
        `worker ${worker} has an adopted terminal but no record of the attach process, so ` +
        `pifleet cannot tell whether anybody is still there to run a staged task. That record ` +
        `is written by up --attach-here; a run started by an older build will not have one. ` +
        `Re-attach with pifleet up --attach-here to record it.`
      );
    case "attach_gone":
      return (
        `worker ${worker}'s adopted terminal is gone — the docker attach recorded as pid ` +
        `${r.pid} has exited, so a staged task would sit with nobody to trigger it. ` +
        `pifleet up --attach-here to come back, then stage it again.`
      );
    case "pid_reused":
      return (
        `worker ${worker}'s adopted terminal is gone: pid ${r.pid} is alive but is NOT the ` +
        `process that was attached — it started at ${r.observed}, and the attach was recorded ` +
        `at ${r.recorded}. The kernel reissued the number to something else. ` +
        `pifleet up --attach-here to come back, then stage it again.`
      );
  }
}

// ---------------------------------------------------------------------------
// Which surface did the operator hand over? (D2, reversed by owner 2026-09-02)
// ---------------------------------------------------------------------------

/**
 * The environment variable a cmux pane sets to name itself. Read here rather
 * than in `src/backends/cmux/` because ISC-137 forbids importing a cmux symbol
 * outside that directory, and this is a variable NAME, not a cmux import — the
 * same reasoning `doctor.ts` already relies on when it reads the pair to decide
 * whether it is running inside a pane.
 */
export const CMUX_SURFACE_ENV = "CMUX_SURFACE_ID";
export const CMUX_WORKSPACE_ENV = "CMUX_WORKSPACE_ID";

/**
 * What surface, if any, the terminal running `up --attach-here` belongs to.
 *
 * ## Why this exists at all — the decision that produced it
 *
 * `Docs/SRD-TUI-DISPATCH.md` D2 recommended NOT recording this, on the grounds
 * that `docker attach --detach-keys=ctrl-]` makes detach one keypress pifleet
 * cannot see, after which anything typed at the surface lands in a host shell.
 * **The owner reversed it on 2026-09-02**, and the design that came back is
 * better than either arm the document offered: the BRIEF still travels through
 * the read-only file plane and never touches the terminal, and only a short
 * TRIGGER is typed. So the exposure §4.3 argued about shrinks from a whole
 * markdown document executed line-by-line to one line — and that line is
 * shaped to be inert in a shell (`src/cli/commands/dispatch.ts`).
 *
 * ## PURE, and the environment is the caller's
 *
 * Passed in rather than read from `process.env` here so every arm below is
 * testable without a cmux, without a pane, and without mutating the test
 * process's own environment — which is a global that other suites read.
 *
 * ## `null` is a first-class answer, not a failure
 *
 * An adopted terminal in Terminal.app, over ssh, or inside tmux announces no
 * cmux surface. That is the majority case for this mode outside the operations
 * console, and it must degrade to "stage it and tell the operator to trigger
 * it" rather than to an error — which is why this returns an id or nothing and
 * never throws. D2's second argument survives its own reversal: a design that
 * only works under cmux must not become a design that only RUNS under cmux.
 */
export function adoptedSurface(
  env: Record<string, string | undefined>,
): { backend: "cmux"; surface: string; workspace: string | null } | null {
  const surface = env[CMUX_SURFACE_ENV];
  if (surface === undefined || surface.trim() === "") return null;
  const workspace = env[CMUX_WORKSPACE_ENV];
  return {
    backend: "cmux",
    surface: surface.trim(),
    workspace: workspace === undefined || workspace.trim() === "" ? null : workspace.trim(),
  };
}
