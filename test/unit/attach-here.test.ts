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

import { beforeAll, describe, expect, test } from "bun:test";
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
    /*
     * `surface_ref` stays null WHEN THE HOST ANNOUNCED NOTHING, which is what
     * a Terminal.app window, an ssh session or a bare tmux pane does — and
     * what this fixture models, since it names no surface.
     *
     * IT IS NO LONGER NULL BY DESIGN. It was, on the reasoning that there is
     * no id anything could send bytes to; a cmux pane announces one in its own
     * environment and `up` runs inside it. Recorded as SRD-TUI-DISPATCH D2,
     * recommended against, and reversed by the owner on 2026-09-02 — under a
     * design that keeps the BRIEF off the terminal entirely and types only a
     * short, shell-inert trigger.
     */
    expect(adopted.surface_ref).toBeNull();
    expect(adopted.surface_backend).toBeNull();

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
 * What `dispatch` does with an adopted pane, now that it does not refuse it.
 *
 * ## What changed and why the old test had to go rather than be adjusted
 *
 * This block used to assert the REFUSAL — that an adopted worker got "there is
 * no surface id to type into" and a sentence naming the operator as the
 * dispatcher. That refusal was correct under D2 and is gone with it. Adjusting
 * the assertions would have left a test whose name and docblock argued for a
 * behaviour the tree no longer has, which is worse than a test that is missing.
 *
 * ## The two properties worth pinning now
 *
 * The fork is on the RECORD and it is taken FIRST, and the original refusal
 * survives for the case it was actually written for. Both matter: a headless
 * run with no pane and an adopted terminal share `backend: "headless"`, so a
 * fork on the backend name would send the wrong one down the staged route, and
 * an adopted terminal satisfies `surface_ref === null || backend === "headless"`
 * by the letter of a condition that no longer means what it says.
 */
describe("dispatch forks an adopted pane into the staged route", () => {
  test("the fork is on the record, and it precedes the no-surface refusal", async () => {
    const src = await Bun.file(
      new URL("../../src/cli/commands/dispatch.ts", import.meta.url).pathname,
    ).text();
    const fork = src.indexOf("if (presentation.adopted_terminal) {");
    const refusal = src.indexOf('presentation.backend === "headless" || presentation.surface_ref === null');
    expect(fork, "the staged fork is gone").toBeGreaterThan(-1);
    expect(refusal, "the no-surface refusal is gone").toBeGreaterThan(-1);
    // ORDER, not merely presence. Below the refusal, the fork is unreachable
    // for every adopted worker — which is the state this replaced.
    expect(fork).toBeLessThan(refusal);
    expect(src).toContain("stageForAdoptedTerminal");
  });

  test("the original refusal survives for the case it was written for", () => {
    // A headless run with no pane at all. D1 does not touch it, and ISC-454
    // is the anti-criterion that says so.
    expect(REFUSAL_SOURCE).toContain("a tui worker's prompt has nowhere to go");
  });

  /**
   * The old sentence is GONE, not merely unreachable. A refusal left in the
   * tree telling an operator that pifleet "has no surface id to type into"
   * would be read as current by the next person to grep for it — and it is now
   * false twice over: there is an id, and pifleet uses it.
   */
  test("and the D2-era refusal is not left lying in the source", () => {
    expect(REFUSAL_SOURCE).not.toContain("has no surface id to type into");
    expect(REFUSAL_SOURCE).not.toContain("could not have been deduplicated anyway");
  });
});

/** The dispatch source, read once — three assertions above search it. */
let REFUSAL_SOURCE = "";
beforeAll(async () => {
  REFUSAL_SOURCE = await Bun.file(
    new URL("../../src/cli/commands/dispatch.ts", import.meta.url).pathname,
  ).text();
});

/**
 * `up --attach-here` records the attach child's `(pid, started)` from the
 * LAUNCHER'S OWN record (ISC-446, D9).
 *
 * ## ISC-191's lesson, applied at a fourth capture site
 *
 * The repo already holds three places where a process identity is captured, and
 * the rule they share is that a pair read off a NAME — a `ps` lookup, a
 * container inspect, a pid file — is not a record. The number outlives the
 * process and the kernel reissues it, so a lookup can only ever describe
 * whatever holds the pid at the moment of the lookup.
 *
 * What makes this site a record rather than a read is the CHILD HANDLE. The
 * process was spawned here, so `child.exitCode === null && child.signalCode ===
 * null` is a statement about the process this code started, not about whatever
 * currently answers to that number.
 *
 * ## The ORDER is the whole argument, and it is asserted rather than described
 *
 * "Not reaped now" implies "not reaped at any earlier instant", so a liveness
 * check that passes AFTER the read vouches for the read. The reverse order
 * vouches for nothing: the process could exit and the pid be reissued between a
 * passing check and a subsequent read, which is precisely the window the pair
 * exists to close. A reviewer swapping these two lines for readability would
 * silently reduce the record to a lookup, and nothing about the resulting code
 * would look wrong.
 */
describe("the attach child is recorded, not looked up (ISC-446)", () => {
  const src = () =>
    Bun.file(new URL("../../src/cli/commands/up.ts", import.meta.url).pathname).text();

  test("the pair comes off the child handle, not a name lookup", async () => {
    const text = await src();
    const at = text.indexOf("const stillOurs = child.exitCode === null");
    expect(at, "the attach capture site is gone or renamed").toBeGreaterThan(-1);
    const block = text.slice(at - 400, at + 500);
    expect(block).toContain("processStartTime(child.pid)");
    expect(block).toContain("attach_process: { pid: child.pid, started }");
  });

  test("the liveness check runs AFTER the read, which is what makes it a record", async () => {
    const text = await src();
    const read = text.indexOf("const started = await processStartTime(child.pid)");
    const check = text.indexOf("const stillOurs = child.exitCode === null");
    expect(read).toBeGreaterThan(-1);
    expect(check).toBeGreaterThan(-1);
    expect(read).toBeLessThan(check);
  });

  /**
   * No `ps` at this site. `processStartTime` is the repo's single shared reader
   * and owns whatever it shells out to; a second spelling here would be a
   * fourth copy of a rule three other sites already share.
   */
  test("nothing shells out to ps here", async () => {
    const text = await src();
    expect(text).not.toContain('"ps"');
    expect(text).not.toContain("'ps'");
  });

  /**
   * AND IT IS CLEARED when the attach ends. Without this the record outlives
   * the reader and the guard INVERTS: a stale pair satisfies the very check
   * that exists to catch a detached terminal, which is a guard reporting
   * success. Asserted as an ordering against `child.exited`, because a clear
   * that ran before the wait would clear a live record.
   */
  test("the record is cleared after the attach exits, not before", async () => {
    const text = await src();
    const exited = text.indexOf("const code = await child.exited;");
    const clear = text.indexOf("attach_process: null }", exited);
    expect(exited).toBeGreaterThan(-1);
    expect(clear, "nothing clears the attach record").toBeGreaterThan(exited);
  });
});
