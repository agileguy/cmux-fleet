/**
 * `up --attach-here` — adopting a pane pifleet did not create.
 *
 * ## The premise that turned out to be wrong
 *
 * `assertTuiBackendPossible` refused `pane_mode: tui` on a headless backend,
 * and its message says why: "A headless run creates no pane, so there is
 * nothing to attach." That was true of every surface the design had —
 * `cmux`/`tmux` (pifleet owns the pane) and `headless` (no pane).
 *
 * The operations console is neither. A pane exists, cmux made it, and pifleet
 * is not the one that made it — so on that surface `--backend headless` is
 * right (the console must not have windows opening under it) and
 * `pane_mode: tui` is right (the point is Pi's interface). **The guard was not
 * wrong; "headless" had been standing in for "no pane exists", and those stop
 * being the same statement the moment a person runs `up` inside a pane.**
 *
 * ## Why the exemption is a second guard rather than a looser first one
 *
 * `assertTuiBackendPossible` gains one early return, and everything that
 * licenses it is established by `assertAttachHere` running before it. Widening
 * the original condition instead would have made one boolean answer four
 * unrelated questions — is there a tui worker, is there exactly one, does the
 * backend already own panes, is this a terminal — and a single boolean cannot
 * be reddened one clause at a time.
 *
 * Every refusal below is paired with the case that must still be ALLOWED,
 * because a guard that refuses everything satisfies half of these tests and is
 * the failure that matters.
 */

import { describe, expect, test } from "bun:test";
import {
  adoptRefusal,
  adoptRefusalMessage,
  adoptedAttachArgv,
  type AdoptRefusal,
} from "../../src/attended/adopt.ts";
import { assertAttachHere, assertTuiBackendPossible } from "../../src/cli/commands/up.ts";
import { DETACH_KEYS } from "../../src/attended/mode.ts";
import { PresentationSchema } from "../../src/contracts.ts";
import { workerContainerName } from "../../src/run/paths.ts";

const OK = {
  tuiWorkers: ["tick-1"],
  backendKind: "headless",
  backendSource: "the built-in default",
  stdinIsTty: true,
  stdoutIsTty: true,
};

describe("adoptRefusal names WHICH precondition failed", () => {
  test("the whole point: one tui worker, headless, a real terminal", () => {
    expect(adoptRefusal(OK)).toBeNull();
  });

  /**
   * Silently ignoring the flag is the failure this refuses: an operator would
   * be left watching a log tail believing they were looking at Pi.
   */
  test("an rpc-only run has nothing to attach to", () => {
    expect(adoptRefusal({ ...OK, tuiWorkers: [] })).toEqual({ kind: "no_tui_worker" });
  });

  /**
   * A process has ONE terminal. Attaching to the first of three and calling
   * the run attended would overclaim for the other two — the one direction
   * `attended/mode.ts` exists to make impossible.
   */
  test("two tui workers cannot share one terminal, and the message names them", () => {
    const r = adoptRefusal({ ...OK, tuiWorkers: ["tick-1", "eng-1"] });
    expect(r).toEqual({ kind: "many_tui_workers", workers: ["tick-1", "eng-1"] });
    const msg = adoptRefusalMessage(r!);
    expect(msg).toContain("tick-1");
    expect(msg).toContain("eng-1");
    // And it says what to do, rather than only what is wrong.
    expect(msg).toContain("--workers");
  });

  /**
   * `--backend cmux --attach-here` is a contradiction: pifleet would create a
   * pane running `docker attach` AND this terminal would attach to the same
   * container. Two readers on one pty is SRD §162 violated by a flag pair.
   */
  test("a backend that owns panes is refused, and the refusal quotes which input chose it", () => {
    const r = adoptRefusal({ ...OK, backendKind: "cmux", backendSource: "--backend" });
    expect(r).toEqual({
      kind: "backend_owns_panes",
      backend: "cmux",
      source: "--backend",
    });
    expect(adoptRefusalMessage(r!)).toContain("--backend");
  });

  /**
   * Both streams, and separately. A TUI reads keys and writes frames; either
   * half alone is a half-usable pane that looks like a working one.
   */
  test("a pipe on either stream is refused, and the message says which", () => {
    expect(adoptRefusal({ ...OK, stdinIsTty: false })).toEqual({
      kind: "not_a_terminal",
      stream: "stdin",
    });
    expect(adoptRefusal({ ...OK, stdoutIsTty: false })).toEqual({
      kind: "not_a_terminal",
      stream: "stdout",
    });
    expect(adoptRefusalMessage({ kind: "not_a_terminal", stream: "stdout" })).toContain("stdout");
  });

  /**
   * Every refusal renders. A `switch` that lost an arm would return
   * `undefined` and the operator would get "refusing to start: undefined".
   */
  test("every refusal kind has a message", () => {
    const all: AdoptRefusal[] = [
      { kind: "no_tui_worker" },
      { kind: "many_tui_workers", workers: ["a", "b"] },
      { kind: "backend_owns_panes", backend: "tmux", source: "backend.kind" },
      { kind: "not_a_terminal", stream: "stdin" },
    ];
    for (const r of all) {
      const m = adoptRefusalMessage(r);
      expect(typeof m).toBe("string");
      expect(m.length).toBeGreaterThan(40);
    }
  });
});

describe("the attach argv", () => {
  test("it is a bare docker attach on this run's container, with the measured detach key", () => {
    expect(adoptedAttachArgv("r-1", "tick-1")).toEqual([
      "docker",
      "attach",
      `--detach-keys=${DETACH_KEYS}`,
      workerContainerName("r-1", "tick-1"),
    ]);
  });

  /**
   * NOT `sh -c`, and that is the criterion rather than an aesthetic.
   *
   * `attachArgv` wraps its attach in a polling shell because a backend pane is
   * created BEFORE the container exists. This path runs after `up` has waited
   * for idle, so the wait could only ever succeed on its first iteration — and
   * an `sh -c` between this process and docker puts a second owner on a
   * terminal §162 says has exactly one.
   */
  test("no shell sits between the process and docker", () => {
    const argv = adoptedAttachArgv("r-1", "tick-1");
    expect(argv[0]).toBe("docker");
    expect(argv).not.toContain("sh");
    expect(argv.join(" ")).not.toContain("-c");
  });
});

describe("the two guards, in the order that makes the exemption safe", () => {
  const headless = { kind: "headless" as const, source: "the built-in default" as const };
  const cmux = { kind: "cmux" as const, source: "--backend" as const };

  test("without the flag, a tui worker on headless is refused exactly as before", () => {
    expect(() => assertTuiBackendPossible({ tuiWorkers: ["tick-1"], backend: headless })).toThrow(
      /nothing to attach/,
    );
  });

  test("with the flag, the same combination is allowed", () => {
    expect(() =>
      assertTuiBackendPossible({ tuiWorkers: ["tick-1"], backend: headless, attachHere: true }),
    ).not.toThrow();
  });

  /**
   * THE CONTROL that keeps the exemption honest. `attachHere: true` reaching
   * the second guard is only ever produced by the first guard passing, so the
   * pairs below are the states a run can actually be in.
   */
  test("the first guard refuses what the second would then have exempted", () => {
    // Two tui workers: adoption impossible, so the exemption is never reached.
    expect(() =>
      assertAttachHere({
        attachHere: true,
        tuiWorkers: ["tick-1", "eng-1"],
        backend: headless,
        stdinIsTty: true,
        stdoutIsTty: true,
      }),
    ).toThrow(/ONE terminal/);
    // A pane-owning backend: refused here, so `--backend cmux --attach-here`
    // can never reach the branch that skips the headless check.
    expect(() =>
      assertAttachHere({
        attachHere: true,
        tuiWorkers: ["tick-1"],
        backend: cmux,
        stdinIsTty: true,
        stdoutIsTty: true,
      }),
    ).toThrow(/docker attach in it/);
    // A pipe: refused, because Pi would render into a file nobody reads.
    expect(() =>
      assertAttachHere({
        attachHere: true,
        tuiWorkers: ["tick-1"],
        backend: headless,
        stdinIsTty: true,
        stdoutIsTty: false,
      }),
    ).toThrow(/not a terminal/);
    // And the one state that passes.
    expect(() =>
      assertAttachHere({
        attachHere: true,
        tuiWorkers: ["tick-1"],
        backend: headless,
        stdinIsTty: true,
        stdoutIsTty: true,
      }),
    ).not.toThrow();
  });

  /**
   * The flag is opt-in at every layer. Without it, nothing about a run
   * changes — including a run with no tui workers at all, which must not
   * start failing because a new guard learned to have opinions.
   */
  test("without the flag the new guard is inert", () => {
    for (const tuiWorkers of [[], ["tick-1"], ["a", "b"]]) {
      for (const backend of [headless, cmux]) {
        expect(() =>
          assertAttachHere({
            attachHere: false,
            tuiWorkers,
            backend,
            stdinIsTty: false,
            stdoutIsTty: false,
          }),
        ).not.toThrow();
      }
    }
  });
});

/**
 * The record has to distinguish an adopted pane from no pane at all, or
 * `report` and `pifleet tui` cannot tell the two apart.
 */
describe("the presentation record", () => {
  test("adopted_terminal round-trips, and defaults to false for older records", () => {
    const adopted = PresentationSchema.parse({
      schema: "pifleet.presentation/v1",
      worker: "tick-1",
      backend: "headless",
      adopted_terminal: true,
    });
    expect(adopted.adopted_terminal).toBe(true);
    // `surface_ref` stays null BY DESIGN: there is no id anything could send
    // bytes to, which is what keeps `dispatch` refusing this worker.
    expect(adopted.surface_ref).toBeNull();

    const old = PresentationSchema.parse({
      schema: "pifleet.presentation/v1",
      worker: "tick-1",
      backend: "cmux",
      surface_ref: "surface:2",
    });
    expect(old.adopted_terminal).toBe(false);
  });
});

/**
 * The refusal an operator actually reads when they try to dispatch.
 *
 * `dispatch` must still refuse an adopted worker — there is no surface id, so
 * there is genuinely nothing to type into — but "nowhere to go" is the wrong
 * DIAGNOSIS here: a pane exists and a person is looking at it. Same refusal,
 * same exit code, different sentence.
 *
 * Asserted on the rendered strings rather than by driving the CLI, because the
 * branch is a ternary on one recorded boolean and the integration path is
 * already covered by `tui-dispatch-pane.test.ts`. Both arms, because a message
 * that said "adopted" unconditionally would be worse than the one it replaced.
 */
describe("dispatch tells an adopted pane apart from no pane", () => {
  test("the two refusals are different sentences and neither is empty", async () => {
    const src = await Bun.file(
      new URL("../../src/cli/commands/dispatch.ts", import.meta.url).pathname,
    ).text();
    // The adopted arm names the flag that created the situation and says who
    // the dispatcher is.
    expect(src).toContain("ADOPTED terminal");
    expect(src).toContain("up --attach-here");
    // And the original arm survives for the case it was written for.
    expect(src).toContain("a tui worker's prompt has nowhere to go");
    // The branch is on the RECORD, not on the backend name — a headless run
    // with no pane and an adopted one share `backend: "headless"`.
    expect(src).toContain("presentation.adopted_terminal");
  });
});
