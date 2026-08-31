/**
 * The `tui` interrupt path (SRD §3.5, TUI spec item 8).
 *
 * `src/container/interrupt.ts` carries the measurements that chose this route;
 * they are not repeated here. What this file pins is the part a measurement
 * cannot: that the two ends the TUI spec says "must move together" are still
 * together, and that they are checkable without a Docker daemon.
 *
 * Three couplings, and each one fails silently if it breaks:
 *
 *  1. the argv itself, byte for byte;
 *  2. `docker/entrypoint.sh` still trapping INT — without that trap the
 *     signal stops at the entrypoint shell and `abort` reports success for a
 *     worker that kept running;
 *  3. `config/render.ts` still leaving BOTH marks that `launchPaneMode` reads
 *     back — without them a tui worker is classified `unknown` and refuses,
 *     which is loud, or worse is classified `rpc` and gets a control message
 *     sent at a socket that was never opened.
 */

import { describe, expect, test } from "bun:test";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { WorkerLaunchSchema, type WorkerLaunch } from "../../src/contracts.ts";
import {
  INTERRUPT_SIGNAL,
  interruptArgv,
  launchPaneMode,
  planInterrupt,
} from "../../src/container/interrupt.ts";

const REPO_ROOT = join(import.meta.dir, "..", "..");

/**
 * A launch record built through the REAL schema, so a field this test invents
 * and the schema does not accept is a failure here rather than a surprise in
 * production. `argv` is the whole command line — docker flags and the pi flag
 * list — because that is what `WorkerLaunchSchema.argv` holds and what the
 * supervisor runs verbatim.
 */
function launch(argv: string[], container = "pifleet-r1-eng-1"): WorkerLaunch {
  return WorkerLaunchSchema.parse({
    kind: "container",
    argv,
    container,
    image: "pifleet/pi-worker:test",
  });
}

/** The shapes `config/render.ts` emits, trimmed to the marks under test. */
const RPC_ARGV = [
  "docker", "run", "-i", "--rm", "--name", "pifleet-r1-eng-1",
  "-v", "/runs/r1/sessions:/sessions",
  "pifleet/pi-worker:test",
  "pi", "--mode", "rpc", "--session-id", "eng-1", "--session-dir", "/sessions",
];
const TUI_ARGV = [
  "docker", "run", "-i", "-t", "--rm", "--name", "pifleet-r1-eng-1",
  "-v", "/runs/r1/sessions:/sessions",
  "pifleet/pi-worker:test",
  "pi", "--session-id", "eng-1", "--session-dir", "/sessions",
];

describe("tui interrupt argv", () => {
  test("is docker kill --signal=INT <container>, byte for byte", () => {
    expect(interruptArgv("pifleet-r1-eng-1")).toEqual([
      "docker",
      "kill",
      "--signal=INT",
      "pifleet-r1-eng-1",
    ]);
    expect(INTERRUPT_SIGNAL).toBe("INT");
  });

  /**
   * The container name is the LAST argument and is never interpolated into an
   * earlier one, so a name that somehow began with a dash could not be read as
   * a flag by `docker kill`. Asserted because the fix for that class of bug is
   * argv position, and position is exactly what a refactor moves.
   */
  test("the container name is the final argument", () => {
    const argv = interruptArgv("weird-name");
    expect(argv[argv.length - 1]).toBe("weird-name");
    expect(argv.filter((a) => a === "weird-name")).toHaveLength(1);
  });
});

describe("launchPaneMode reads the mode back off the rendered argv", () => {
  test("an rpc worker: --mode rpc present, -t absent", () => {
    expect(launchPaneMode(launch(RPC_ARGV))).toBe("rpc");
  });

  test("a tui worker: -t present, --mode rpc absent", () => {
    expect(launchPaneMode(launch(TUI_ARGV))).toBe("tui");
  });

  /**
   * Both disagreement shapes are `unknown`, and both directions are asserted
   * because they arrive from opposite bugs: a renderer that stopped emitting
   * `-t` for tui, and one that stopped omitting `--mode rpc`. Either alone
   * would leave a single-mark reader confidently wrong.
   */
  test("marks that disagree are unknown, in both directions", () => {
    const bothMarks = [...TUI_ARGV.slice(0, 10), "pi", "--mode", "rpc", "--session-id", "eng-1"];
    expect(launchPaneMode(launch(bothMarks))).toBe("unknown");

    const neitherMark = ["docker", "run", "-i", "--rm", "img", "pi", "--session-id", "eng-1"];
    expect(launchPaneMode(launch(neitherMark))).toBe("unknown");
  });

  /**
   * `-t` is matched as a whole argument. A bind mount whose path merely
   * CONTAINS "-t" is not a TTY request, and a substring test would say it was.
   */
  test("a mount path containing -t does not read as a tty request", () => {
    const withMount = [
      "docker", "run", "-i", "--rm", "-v", "/runs/build-tools:/tools", "img",
      "pi", "--mode", "rpc", "--session-id", "eng-1",
    ];
    expect(launchPaneMode(launch(withMount))).toBe("rpc");
  });

  /**
   * `--mode` must be followed by `rpc` specifically. A `--skill rpc` or a path
   * segment spelled `rpc` is not a mode declaration.
   */
  test("a bare rpc token that is not --mode's value does not read as rpc mode", () => {
    const bare = ["docker", "run", "-i", "-t", "--rm", "img", "pi", "--skill", "rpc"];
    expect(launchPaneMode(launch(bare))).toBe("tui");
  });
});

describe("planInterrupt", () => {
  test("an rpc worker keeps the RPC control plane", () => {
    expect(planInterrupt(launch(RPC_ARGV))).toEqual({ kind: "rpc" });
  });

  test("a tui worker is signalled by container name", () => {
    const plan = planInterrupt(launch(TUI_ARGV));
    expect(plan).toEqual({
      kind: "signal",
      container: "pifleet-r1-eng-1",
      argv: ["docker", "kill", "--signal=INT", "pifleet-r1-eng-1"],
    });
  });

  /**
   * No launch record is the `PIFLEET_PI_COMMAND` double. It must not fall
   * through to either route: there is no container to signal and no claim to
   * make about a socket.
   */
  test("a worker with no launch record is unavailable, not rpc and not signal", () => {
    const plan = planInterrupt(null);
    expect(plan.kind).toBe("unavailable");
    if (plan.kind !== "unavailable") throw new Error("unreachable");
    expect(plan.reason).toContain("no launch record");
  });

  test("disagreeing marks refuse rather than guess", () => {
    const plan = planInterrupt(launch(["docker", "run", "-i", "--rm", "img", "pi"]));
    expect(plan.kind).toBe("unavailable");
  });
});

/**
 * THE COUPLING PROBES.
 *
 * These read source files rather than behaviour, and that is the point: the
 * behaviour they guard needs a Docker daemon and a real image to observe, so a
 * suite that could only assert it would assert nothing on most machines. A
 * lexical probe that fails loudly when the other end moves is worth more than
 * a runtime probe that skips itself.
 *
 * What they do NOT claim: that the signal arrives. That was measured once, by
 * hand, against the real image, and the measurement is recorded in
 * `src/container/interrupt.ts`. These pin the preconditions that measurement
 * depended on, so a future edit cannot quietly invalidate it.
 */
describe("the ends that must move together", () => {
  test("entrypoint.sh still traps INT — without it docker kill --signal=INT is a no-op", async () => {
    const script = await readFile(join(REPO_ROOT, "docker", "entrypoint.sh"), "utf8");
    const trap = /^\s*trap\s+forward\s+(.+)$/m.exec(script);
    expect(trap).not.toBeNull();
    const signals = (trap?.[1] ?? "").trim().split(/\s+/);
    expect(signals).toContain("INT");
    // TERM too: the trap's other job is a clean `docker stop`, and an edit
    // that dropped it would turn every shutdown into a SIGKILL after the full
    // grace period. Not this path's concern, but it is the same one line.
    expect(signals).toContain("TERM");
  });

  test("render.ts still leaves both marks launchPaneMode reads", async () => {
    const render = await readFile(join(REPO_ROOT, "src", "config", "render.ts"), "utf8");
    // The rpc mark: `--mode rpc` is pushed for anything that is not tui.
    expect(render).toContain(`if (w.paneMode !== "tui") argv.push("--mode", "rpc");`);
    // The tui mark: `-t` is pushed for tui.
    expect(render).toContain(`if (w.paneMode === "tui") argv.push("-t");`);
  });
});
