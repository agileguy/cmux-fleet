/**
 * A `tui` worker's pane shows the live Pi TUI (TUI spec item 9).
 *
 * ## What is actually at risk here
 *
 * Not the tui pane. It did not exist before this phase, so it has no
 * behaviour to regress. The risk is the ROUTING: one new call site now
 * decides what every pane in the fleet runs, and the failure that costs
 * something is an edit that sends rpc workers — which is every worker a
 * default config produces — down the new path. So the load-bearing assertions
 * below are the ones about the pane that did NOT change:
 *
 *  - an rpc launch record returns the viewer, by IDENTITY, so a routing edit
 *    that rebuilt the argv "equivalently" still fails;
 *  - the double (`launch === null`) returns the viewer;
 *  - a record whose mode cannot be trusted returns the viewer.
 *
 * ## The detach keys are a measurement, and this file pins the result
 *
 * `docker attach` defaults to `ctrl-p,ctrl-q` and **Pi binds ctrl-p** to its
 * model switcher — measured 2026-08-31 against the real image with a pty, a
 * zero-noise negative control and a positive control proving the instrument
 * could see a reaction at all. The full arm table is in `attended/mode.ts`
 * beside `DETACH_KEYS`. The test here is deliberately written as "must not be
 * the docker default" rather than only "must equal ctrl-]", because the defect
 * being guarded is REVERTING to the default, and an equality test alone would
 * read as an arbitrary preference to the next person deciding to simplify it.
 */

import { describe, expect, test } from "bun:test";
import { WorkerLaunchSchema, type WorkerLaunch } from "../../src/contracts.ts";
import {
  ATTACH_WAIT_SECONDS,
  DETACH_KEYS,
  attachArgv,
  interactiveArgv,
} from "../../src/attended/mode.ts";
import { panePresentationArgv } from "../../src/cli/commands/up.ts";

const RUN = "r1";
const WORKER = "eng-1";
const CONTAINER = `pifleet-${RUN}-${WORKER}`;

/** The shapes `config/render.ts` emits, trimmed to the marks under test. */
const RPC_ARGV = [
  "docker", "run", "-i", "--rm", "--name", CONTAINER,
  "pifleet/pi-worker:test",
  "pi", "--mode", "rpc", "--session-id", WORKER,
];
const TUI_ARGV = [
  "docker", "run", "-i", "-t", "--rm", "--name", CONTAINER,
  "pifleet/pi-worker:test",
  "pi", "--session-id", WORKER,
];

function launch(argv: string[], paneMode: "rpc" | "tui"): WorkerLaunch {
  return WorkerLaunchSchema.parse({
    kind: "container",
    argv,
    container: CONTAINER,
    image: "pifleet/pi-worker:test",
    pane_mode: paneMode,
  });
}

/** Stands in for the argv `up` builds inline; identity is what is asserted. */
const VIEWER = Object.freeze([
  "env", "PIFLEET_RUNS_DIR=/runs", "/bin/bun", "/cli/index.ts",
  "logs", "--worker", WORKER, "--run", RUN, "--follow", "--render",
]);

function route(launchRecord: WorkerLaunch | null): readonly string[] {
  return panePresentationArgv({
    launch: launchRecord,
    viewer: VIEWER,
    runId: RUN,
    workerId: WORKER,
  });
}

describe("an rpc worker's pane is untouched", () => {
  /**
   * `toBe`, not `toEqual`. The mutation this exists to catch is a routing
   * edit that builds the viewer argv again on the way past — structurally
   * equal, and wrong the moment the two copies drift. `panePresentationArgv`
   * takes the viewer as a parameter precisely so it is incapable of
   * rebuilding it, and identity is how that stays true.
   */
  test("a consistent rpc record returns the SAME viewer array", () => {
    expect(route(launch(RPC_ARGV, "rpc"))).toBe(VIEWER);
  });

  /**
   * The `PIFLEET_PI_COMMAND` double: no container, but a live supervisor and
   * control socket. A worker with no container is an rpc worker — the reading
   * `planInterrupt(null)` settled on after previously refusing here from a
   * true premise and a wrong conclusion. This is the arm the entire e2e and
   * integration suite runs under, so getting it wrong would hand a `docker
   * attach` to every pane in every test that has no container at all.
   */
  test("the double — no launch record — returns the viewer", () => {
    expect(route(null)).toBe(VIEWER);
  });

  /**
   * Mode UNREADABLE takes the read-only arm, in both directions of
   * disagreement. A pane showing logs for a worker whose mode is in doubt
   * costs a view; attaching a keyboard to what might be an RPC control plane
   * costs the run.
   */
  test.each([
    ["record says tui, argv has no -t", TUI_ARGV.filter((a) => a !== "-t"), "tui" as const],
    ["record says rpc, argv has -t", TUI_ARGV, "rpc" as const],
  ])("%s -> viewer", (_name, argv, mode) => {
    expect(route(launch(argv, mode))).toBe(VIEWER);
  });
});

describe("a tui worker's pane attaches to Pi's own TTY", () => {
  test("a consistent tui record returns the attach argv", () => {
    expect(route(launch(TUI_ARGV, "tui"))).toEqual(attachArgv(RUN, WORKER));
  });

  test("it is docker attach on this worker's container, and not the viewer", () => {
    const argv = route(launch(TUI_ARGV, "tui"));
    expect(argv).not.toBe(VIEWER);
    expect(argv.join(" ")).toContain("docker attach");
    expect(argv).toContain(CONTAINER);
  });
});

describe("the detach sequence", () => {
  /**
   * The measured collision. ctrl-p drives Pi's model switcher (a 5153-byte
   * repaint reading "Only one model available", against a zero noise floor),
   * so leaving docker's default in place gives a pane that eats a keybind of
   * the program it is showing.
   */
  test("is not docker's default, which collides with a Pi keybind", () => {
    expect(DETACH_KEYS).not.toBe("ctrl-p,ctrl-q");
    expect(DETACH_KEYS).not.toContain("ctrl-p");
  });

  test("is the measured-safe sequence, and reaches the attach argv", () => {
    expect(DETACH_KEYS).toBe("ctrl-]");
    expect(attachArgv(RUN, WORKER).join(" ")).toContain(`--detach-keys=${DETACH_KEYS}`);
  });

  /**
   * ctrl-\ is ALSO unbound in Pi, and is still wrong. `container/interrupt.ts`
   * records two windows where Pi's raw mode does not hold — startup, and the
   * `!` bash escape — and ISIG is live in both, which makes ctrl-\ a SIGQUIT
   * to the pty's foreground group and a dead worker. Pinned so the next person
   * choosing "any unbound control character" has the reason in front of them.
   */
  test("is not a sequence the tty driver claims when ISIG is live", () => {
    for (const unsafe of ["ctrl-\\", "ctrl-c", "ctrl-z"]) {
      expect(DETACH_KEYS).not.toBe(unsafe);
    }
  });
});

describe("the attach argv waits for its container", () => {
  /**
   * NOT a race guard, and the distinction is the whole reason the wait is
   * unconditional. Read out of `up.ts`: the pane is created, the supervisor is
   * launched with `launchDetached`, and only then is this argv attached —
   * while `launchDetached` returns when the supervisor PROCESS is spawned, and
   * the supervisor runs `docker run -d` itself afterwards. A bare `docker
   * attach` here does not fail occasionally; it fails every single time.
   */
  test("polls docker inspect before attaching", () => {
    const script = attachArgv(RUN, WORKER)[2] ?? "";
    expect(script).toContain("docker inspect");
    expect(script).toContain("State.Running");
    // The attach must be INSIDE the wait, not beside it.
    expect(script.indexOf("docker inspect")).toBeLessThan(script.indexOf("docker attach"));
  });

  test("gives up loudly and keeps the pane readable", () => {
    const script = attachArgv(RUN, WORKER)[2] ?? "";
    expect(script).toContain(String(ATTACH_WAIT_SECONDS));
    expect(script).toContain("supervisor.log");
    // A pane that exits on timeout takes the diagnosis with it.
    expect(script).toContain("sleep 3600");
  });

  /**
   * The container name is an ARGUMENT, never interpolated into the script.
   * Interpolating would make every run id and worker id shell syntax — the
   * mistake `backends/cmux/index.ts` writes a 0700 script and spawns it by
   * path specifically to avoid.
   */
  test("passes the container name positionally, not as shell syntax", () => {
    const argv = attachArgv(RUN, WORKER);
    expect(argv[0]).toBe("sh");
    expect(argv[1]).toBe("-c");
    expect(argv[2]).not.toContain(CONTAINER);
    expect(argv.at(-1)).toBe(CONTAINER);
    expect(argv[2]).toContain('"$1"');
  });
});

/**
 * The refusal `interactiveArgv`'s docblock carries was RESTATED for this
 * phase, not relaxed, and this is what stops a later reader from reading the
 * new `attachArgv` as permission to simplify the two into one.
 */
describe("the rpc refusal still stands", () => {
  test("interactiveArgv is docker exec, never docker attach", () => {
    const argv = interactiveArgv(RUN, WORKER);
    expect(argv).toEqual(["docker", "exec", "-it", CONTAINER, "bash"]);
    expect(argv).not.toContain("attach");
  });
});
