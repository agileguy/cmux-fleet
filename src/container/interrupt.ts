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
 * A worker's pane mode: the RECORDED decision, checked against the argv.
 *
 * ## The source, and why it changed
 *
 * This function first read the mode OFF the argv, and its docblock said why:
 * "the mode is NOT recorded as a field anywhere durable — `WorkerState` has no
 * pane mode and `launch.json` has no pane mode". That was true when it was
 * written and is no longer: `WorkerLaunchSchema.pane_mode` now carries
 * `resolveWorker`'s output, written by the one process that resolves it.
 *
 * So the source is the field, for the reason the field exists — **a flag is
 * evidence of a decision, not the decision.** `-t` could arrive from
 * `docker.extra_args`, could be spelled `--tty`, and could one day be right for
 * an `rpc` worker for an unrelated reason; each of those turns a string search
 * into a confident wrong answer about which control plane a worker has.
 *
 * ## The marks are kept, demoted to a CROSS-CHECK
 *
 * They are not redundant with the field, because they fail differently. The
 * field says what `up` DECIDED; the marks say what it RENDERED. Two independent
 * marks are left by `config/render.ts`:
 *
 *   `--mode rpc` present   <=>  paneMode !== "tui"   (render.ts, buildPiArgv)
 *   `-t` present           <=>  paneMode === "tui"   (render.ts, buildDockerArgv)
 *
 * A record that says `tui` over an argv with no `-t` is not a worker whose mode
 * is in doubt — it is a worker that CANNOT WORK, launched detached into a
 * container with no pseudo-TTY and therefore no Pi TUI. The supervisor has no
 * way to notice that and no way to survive it. Reporting `unknown` here refuses
 * to guess and puts the disagreement in the operator's error message, which is
 * the same discipline the entrypoint uses when it checks both `-t 0` and
 * `/dev/tty` before believing it has a terminal.
 *
 * That is why the three-way agreement is required rather than the field simply
 * trusted: dropping the marks would make this function correct and useless, and
 * dropping the field would make it confident and wrong.
 *
 * `-t` is matched exactly and not as a substring: `--tty` is not a form this
 * renderer emits, and `-t` appears in no other flag it does emit, but a
 * substring test would also match a bind-mount path containing "-t".
 *
 * **DOES NOT CLAIM** that a record predating the field is diagnosable. It
 * parses as `rpc` by schema default (deliberately — see `contracts.ts`), so an
 * OLD tui record reads as a renderer disagreement rather than as an old record.
 * Both answers are `unknown`, both refuse, and the operator is told the marks
 * disagree; nothing here can tell the two causes apart.
 */
export function launchPaneMode(launch: WorkerLaunch): "rpc" | "tui" | "unknown" {
  const argv = launch.argv;
  const hasTty = argv.includes("-t");
  // `--mode` followed by `rpc`, rather than either token alone: `--mode` is
  // also how a future flag could spell something else, and a bare `rpc` could
  // be a skill name or a path segment.
  const modeAt = argv.indexOf("--mode");
  const rpcMode = modeAt >= 0 && argv[modeAt + 1] === "rpc";

  // The marks must agree with EACH OTHER and with the record. Written as the
  // recorded mode leading, so a reader sees which one is the source.
  if (launch.pane_mode === "rpc" && rpcMode && !hasTty) return "rpc";
  if (launch.pane_mode === "tui" && !rpcMode && hasTty) return "tui";
  return "unknown";
}

/**
 * Decide how to interrupt one worker.
 *
 * ## `launch === null` is an RPC worker, and the first version said otherwise
 *
 * The record's absence is the `PIFLEET_PI_COMMAND` double: a plain process on
 * this host with no container. That much is a fact being read. This function
 * originally drew `unavailable` from it, with the reason "no container to
 * signal" — true, and the wrong conclusion. **Having no container is not the
 * same as having no control plane.** The double runs under a supervisor with a
 * live RPC client and a control socket, and `abort` over that socket is how
 * ISC-81 has always been satisfied.
 *
 * MEASURED as a regression rather than reasoned about: two integration tests in
 * `test/integration/abort.test.ts` went red with
 * `cannot be aborted: no launch record`, one of them ISC-81's own busy-to-idle
 * clock. Every unit test stayed green, because the unit test for this branch
 * asserted the refusal — it pinned the defect rather than catching it. That is
 * the shape worth remembering: a probe written from the same wrong premise as
 * the code confirms it forever.
 *
 * `src/supervisor/index.ts` had already reached the opposite conclusion for the
 * same case, in as many words: *"`launch === null` — the `PIFLEET_PI_COMMAND`
 * double path — is `rpc` and cannot be anything else. The double is a plain
 * process on this host, there is no container to detach and no terminal to
 * attach to."* One fleet cannot hold both answers: a supervisor that gives the
 * double an RPC control plane, and an `abort` that tells the operator it has
 * none. This is the supervisor's answer, restated here.
 *
 * There is no ambiguity to guard against, either. `tui` mode is a property of a
 * CONTAINER's TTY, so a worker with no container cannot be in it — which is why
 * this returns the route directly instead of consulting `launchPaneMode`.
 */
export function planInterrupt(launch: WorkerLaunch | null): InterruptPlan {
  if (launch === null) return { kind: "rpc" };

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
