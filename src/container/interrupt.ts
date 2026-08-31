/**
 * How a worker is interrupted when there is no RPC control plane (SRD §3.5,
 * TUI spec item 8).
 *
 * SRD §3.5 says a `tui` worker is interrupted with `docker kill --signal=INT`,
 * and the TUI spec's §2.8 says that cannot work and asks for a measurement
 * before the choice is made. The measurement was taken on 2026-08-31 against
 * the real image (`pifleet/pi-worker:0.79.6-base-28cde8879cf9`), one fresh
 * container in the production `tui` shape per row, hit exactly once:
 *
 *   control: no signal at all             Running=true   (baseline)
 *   docker kill --signal=INT   (PID 1)    Running=false  ExitCode=0
 *   docker kill --signal=TERM  (PID 1)    Running=false  ExitCode=0
 *   kill -INT  <entrypoint shell>         Running=false  ExitCode=0
 *   kill -INT  <pi>            (single)   Running=false  ExitCode=130
 *   kill -INT  <pi>            (double)   Running=false  ExitCode=130
 *   kill -TERM <pi>                       Running=false  ExitCode=0
 *
 * Three findings, and each one contradicts something §2.8 assumed.
 *
 * ## 1. SIGINT is not an interrupt for Pi. It is a kill.
 *
 * `kill -INT` on the Pi process ends it with 130 — 128+SIGINT, the default
 * disposition — and a SECOND INT 150 ms later changes nothing, because there
 * is nothing left to send it to. §2.8 records Pi's double-INT response as
 * unmeasured and asks for it; the answer is that the question does not arise.
 * Pi installs no SIGINT handler that interrupts a turn. Its turn-interrupt is
 * the ESCAPE **keystroke** — the TUI's own keybind bar says so
 * ("escape interrupt · ctrl+c/ctrl+d clear/exit") — which travels through the
 * pane as a byte, not through the kernel as a signal.
 *
 * So no signal delivery, single or double, direct or forwarded, can produce
 * the "interrupt the turn and keep the worker" semantics §3.5's wording
 * implies. That option does not exist to be chosen.
 *
 * ## 2. `docker kill --signal=INT` is NOT a no-op today. It stops the worker.
 *
 * §2.8 predicts a silent no-op, reasoning that `docker kill` signals PID 1
 * only and that tini is started without `-g` (both true — see the Dockerfile's
 * `ENTRYPOINT ["/usr/bin/tini","--", …]`). The step it misses is the one
 * immediately after: tini forwards to its direct child, the entrypoint shell,
 * whose `trap forward TERM INT HUP` converts the INT into `kill -TERM` on the
 * worker — and Pi exits CLEANLY on SIGTERM (exit 0, measured on the last row).
 * The entrypoint then exits with the worker's code and the container stops.
 *
 * The effect reaches the worker; only the SIGNAL does not. `docker kill
 * --signal=INT` is therefore already a graceful STOP of a tui worker, which is
 * the coarser thing §3.5 can actually have, and is what this module plans.
 *
 * ## 3. A person's Ctrl-C in an attached pane does NOT kill the worker.
 *
 * This is the residual §2.8 calls unshippable, and it does not reproduce in
 * the production shape. Pi's TUI puts the pty into raw mode. Measured with
 * `stty -a -F /dev/pts/0` inside the running container, against a control arm
 * that differs in ONE variable — which binary owns the terminal:
 *
 *   worker = pi   (the production tui shape)   ->  -isig   (ISIG DISABLED)
 *   worker = cat  (PIFLEET_WORKER_BIN seam)    ->   isig   (ISIG enabled)
 *
 * With ISIG off the tty driver generates no SIGINT at all: byte 0x03 is
 * delivered to Pi's stdin as data and consumed by its own "clear" keybind. The
 * entrypoint's trap cannot fire from a keystroke, so the worker is not killed
 * and there is no double delivery. §2.8's second bullet — and the "double
 * delivers" cell of its table — describe the CONTROL arm: a container whose
 * foreground process leaves the terminal cooked. That is not what a tui worker
 * runs. The process groups §2.8 cites are also off by a number: measured
 * pgrp is 7 for both the shell and Pi (tini is pgrp 1 and is NOT in the pty's
 * foreground group), not 1 as recorded — the substance of the claim, that the
 * shell and the worker share the foreground group, does hold.
 *
 * ## What this module therefore does, and what it does NOT claim
 *
 * It plans `docker kill --signal=INT`, exactly the verb §3.5 names, and does
 * not ask for an entrypoint change: the existing `trap forward TERM INT HUP`
 * is precisely what makes the verb reach the worker. Removing INT from that
 * trap — §2.8's "supervisor ignores INT" option — would turn this into the
 * genuine no-op §2.8 already feared. The two ends are coupled, and the
 * coupling is pinned by a probe rather than by this sentence:
 * `test/unit/tui-interrupt.test.ts` reads the real script and fails if INT
 * leaves that trap.
 *
 * NOT CLAIMED, and each is a real bound rather than a hedge:
 *
 *  - **This is a stop, not a turn-interrupt.** The worker ends. `abort` on an
 *    rpc worker cancels an epoch and leaves the worker alive; on a tui worker
 *    the same word means something coarser, which is why the caller reports it
 *    differently instead of pretending the two are the same operation.
 *  - **Raw mode is Pi's, and holds only while Pi's TUI owns the terminal.**
 *    Two windows were NOT measured: container startup before Pi sets raw mode,
 *    and Pi's `!` bash escape, which hands the terminal to a subshell. In
 *    either window ISIG may be on, and a Ctrl-C would then reach the shared
 *    foreground group and fire the trap. Nothing here depends on those windows
 *    being safe; they are recorded so the next reader does not mistake finding
 *    3 for a proof about all of a pane's lifetime.
 *  - **INT and TERM are measured-equivalent through this entrypoint** (rows 2
 *    and 3 above: both exit 0, both by way of the same trap). INT is used
 *    because §3.5 names it, not because it behaves differently.
 */

import type { WorkerLaunch } from "../contracts.ts";

/**
 * The signal §3.5 names. Not a parameter: a caller that could choose would be
 * a caller that could pick one the entrypoint's trap does not catch, and the
 * probe that pins the trap could no longer speak for every call site.
 */
export const INTERRUPT_SIGNAL = "INT";

/**
 * How a given worker can be interrupted.
 *
 * Three arms rather than a boolean because the third is the one that must not
 * be silently folded into either other: a worker with no launch record has no
 * container, so there is nothing to signal AND nothing to prove dead. Folding
 * it into `rpc` would send a control message to a socket that may not exist;
 * folding it into `signal` would run `docker kill` against a name nobody
 * created. Naming it makes the caller answer for it.
 */
export type InterruptPlan =
  /** An `rpc` worker: the control socket owns this, unchanged. */
  | { kind: "rpc" }
  /** A `tui` worker: signal the container by name. */
  | { kind: "signal"; container: string; argv: string[] }
  /** Neither route is available, with the reason an operator can act on. */
  | { kind: "unavailable"; reason: string };

/**
 * `docker kill --signal=INT <container>`.
 *
 * Separate from the planner so the argv can be pinned byte-for-byte by a test
 * that does not have to build a launch record to see it.
 */
export function interruptArgv(container: string): string[] {
  return ["docker", "kill", `--signal=${INTERRUPT_SIGNAL}`, container];
}

/**
 * Read a worker's pane mode back off the argv `up` actually rendered.
 *
 * The mode is NOT recorded as a field anywhere durable — `WorkerState` has no
 * pane mode and `launch.json` has no pane mode — so it is read from the one
 * artifact that cannot disagree with what was launched: the argv the
 * supervisor runs VERBATIM (`WorkerLaunchSchema.argv`). Two independent marks
 * are left there by `config/render.ts`, and both are checked:
 *
 *   `--mode rpc` present   <=>  paneMode !== "tui"   (render.ts, buildPiArgv)
 *   `-t` present           <=>  paneMode === "tui"   (render.ts, buildDockerArgv)
 *
 * Requiring them to AGREE is deliberate, and it is the same shape the
 * entrypoint uses when it checks both `-t 0` and `/dev/tty` before believing
 * it has a terminal: either mark alone would keep working through a renderer
 * change that moved only the other one, and would then answer confidently
 * about a worker that is no longer the thing it names. A disagreement is a
 * renderer bug, and it is reported as unknown rather than guessed.
 *
 * `-t` is matched exactly and not as a substring: `--tty` is not a form this
 * renderer emits, and `-t` appears in no other flag it does emit, but a
 * substring test would also match a bind-mount path containing "-t".
 */
export function launchPaneMode(launch: WorkerLaunch): "rpc" | "tui" | "unknown" {
  const argv = launch.argv;
  const hasTty = argv.includes("-t");
  // `--mode` followed by `rpc`, rather than either token alone: `--mode` is
  // also how a future flag could spell something else, and a bare `rpc` could
  // be a skill name or a path segment.
  const modeAt = argv.indexOf("--mode");
  const rpcMode = modeAt >= 0 && argv[modeAt + 1] === "rpc";

  if (rpcMode && !hasTty) return "rpc";
  if (!rpcMode && hasTty) return "tui";
  return "unknown";
}

/**
 * Decide how to interrupt one worker.
 *
 * `launch === null` is the `PIFLEET_PI_COMMAND` double — the launch record's
 * absence already means "no container was started" (`WorkerLaunchSchema`), so
 * this is a fact being read, not an inference.
 */
export function planInterrupt(launch: WorkerLaunch | null): InterruptPlan {
  if (launch === null) {
    return {
      kind: "unavailable",
      reason:
        "no launch record — this worker was started against the PIFLEET_PI_COMMAND double, " +
        "so it has no container to signal",
    };
  }

  const mode = launchPaneMode(launch);
  if (mode === "rpc") return { kind: "rpc" };
  if (mode === "unknown") {
    return {
      kind: "unavailable",
      reason:
        `launch argv carries neither a consistent rpc nor a consistent tui shape ` +
        `(--mode rpc and -t disagree) — refusing to guess which control plane this worker has`,
    };
  }

  if (launch.container === "") {
    return {
      kind: "unavailable",
      reason: "tui worker has no recorded container name — nothing to signal",
    };
  }
  return {
    kind: "signal",
    container: launch.container,
    argv: interruptArgv(launch.container),
  };
}
