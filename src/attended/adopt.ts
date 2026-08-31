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
