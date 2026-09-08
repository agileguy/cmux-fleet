/**
 * The line pifleet types into an adopted terminal, and the two properties that
 * make typing there defensible at all.
 *
 * `SRD-TUI-DISPATCH` §4.3's argument against ever typing at this surface was:
 * detach is one `ctrl-]` pifleet cannot observe, after which the surface hosts
 * the operator's own SHELL, and a rendered brief would be delivered into it
 * line by line as commands. The owner reversed D2 on 2026-09-02. The reversal
 * is defensible because the design that came back removes both halves of that
 * sentence — the brief does not go to the terminal, and the one line that does
 * cannot execute.
 *
 * Both halves are asserted here. Neither needs a pty.
 */

import { describe, expect, test } from "bun:test";

import { CmuxBackend } from "../../src/backends/cmux/index.ts";
import type { ExecResult } from "../../src/container/run.ts";
import {
  STAGED_TRIGGER_LINE,
  assertPaneTypeableLine,
  PANE_KEYS,
  SESSION_RESET_LINE,
  HOST_AUTHORED_PANE_LINES,
  assertHostAuthoredPaneLine,
} from "../../src/util/pane-text.ts";

describe("the staged trigger cannot execute if it lands in a shell", () => {
  /**
   * THE property. In `bash`/`sh` a leading `#` makes the line a comment, so the
   * payload is not executed. In interactive `zsh`, where `INTERACTIVE_COMMENTS`
   * is off by default, it is a parse error — noisy, and still not an execution.
   */
  test("it begins with a comment marker", () => {
    expect(STAGED_TRIGGER_LINE.startsWith("#")).toBe(true);
  });

  /**
   * A `#` at the front is worth nothing if a later metacharacter can start a
   * new command. `;`, `&`, `|` and a newline all end a comment's protection in
   * at least one shell reading, and `$(…)` / backticks are substitutions a
   * history-expanding or `interactive_comments`-enabled shell could reach.
   * None of them is needed to say "read this file", so none is present.
   */
  test.each([[";"], ["&"], ["|"], ["`"], ["$("], ["\n"], ["\r"], [">"], ["<"]])(
    "it contains no %j",
    (bad) => {
      expect(STAGED_TRIGGER_LINE).not.toContain(bad);
    },
  );

  test("it names the drop file, so a person reading it knows what to do", () => {
    expect(STAGED_TRIGGER_LINE).toContain("/policy/dispatch");
  });

  /**
   * Held to the same standard as any other text this fleet types. The gate is
   * what refuses control characters and over-long lines, and a trigger exempt
   * from it would be a second, weaker rule for the one line that reaches a
   * terminal pifleet does not own.
   */
  test("it passes the same gate every typed line passes", () => {
    expect(() => assertPaneTypeableLine("staged trigger", STAGED_TRIGGER_LINE)).not.toThrow();
  });

  test("it is ONE line — a multi-line trigger would be a brief again", () => {
    expect(STAGED_TRIGGER_LINE.split("\n")).toHaveLength(1);
  });
});

describe("the staged route types the trigger and nothing else", () => {
  const src = () =>
    Bun.file(new URL("../../src/cli/commands/dispatch.ts", import.meta.url).pathname).text();

  /**
   * CODE, not prose. Every assertion below is about what the route DOES, and
   * these docblocks discuss `paneKeystrokes` at length precisely to say why it
   * is not used — so a search over the raw text answers the opposite of the
   * question being asked. Stripping comments first is what makes "does not go
   * through paneKeystrokes" a claim about the program.
   */
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /**
   * ISC-436, in the form the D2 reversal leaves it. The original anti-criterion
   * was "staging types nothing", which is now false by design. The property
   * worth keeping is the one that actually carried the safety argument: the
   * BRIEF never reaches a terminal.
   *
   * `paneKeystrokes` is the machine that turns a rendered prompt into N sends.
   * Its absence from the staged route is what makes the claim structural rather
   * than a matter of care — there is no code path from `stageForAdoptedTerminal`
   * to a plan over the prompt.
   */
  test("sendStagedTrigger does not go through paneKeystrokes", async () => {
    const text = await src();
    const from = text.indexOf("async function sendStagedTrigger");
    expect(from).toBeGreaterThan(-1);
    const body = code(text.slice(from));
    expect(body).not.toContain("paneKeystrokes");
    // …and it sends the constant, not a rendered anything.
    expect(body).toContain("STAGED_TRIGGER_LINE");
  });

  test("the staged route never renders the prompt into keystrokes", async () => {
    const text = await src();
    const from = text.indexOf("async function stageForAdoptedTerminal");
    const to = text.indexOf("async function sendStagedTrigger");
    expect(from).toBeGreaterThan(-1);
    expect(to).toBeGreaterThan(from);
    const body = code(text.slice(from, to));
    // It renders the prompt — for the DROP FILE — and must not plan it.
    expect(body).toContain("renderPrompt");
    expect(body).toContain("writeDispatchPolicy");
    expect(body).not.toContain("paneKeystrokes");
  });

  /**
   * `surface_backend`, never `backend`. The run's backend for an adopted
   * worker is `headless`, and `loadBackend("headless")` returns something with
   * no `sendText` at all — so this mutation does not crash, it silently makes
   * every trigger undeliverable and reports the task staged-but-not-triggered
   * forever.
   */
  test("the trigger addresses the surface's owner, not the run's backend", async () => {
    const text = await src();
    const from = text.indexOf("async function sendStagedTrigger");
    const body = code(text.slice(from));
    expect(body).toContain("presentation.surface_backend");
    expect(body).not.toContain("presentation.backend");
  });

  test("the submit key comes from the closed vocabulary", () => {
    expect(PANE_KEYS).toContain("enter");
  });
});

/**
 * The trigger has to REACH the surface, and for months it did not.
 *
 * Everything above asserts what the trigger line is and which route sends it.
 * None of it asks whether the send survives the pane id it is given, and that
 * is where every staged dispatch on this machine actually died:
 *
 *   CmuxParseError: cmux: could not parse composed pane id:
 *   5C9D22AC-543A-4B1A-A2E6-6555573DB407
 *
 * `up --attach-here` adopts `CMUX_SURFACE_ENV`, which cmux sets to a bare
 * surface UUID. `sendText` split that through `splitPaneId`, which demanded
 * two or three space-separated fields, and threw — while wanting nothing but
 * the surface the string already was. The task stayed staged and durable, the
 * ledger recorded `stage_trigger_deferred`, and the worker sat idle holding a
 * task nobody had told it about. Measured in run `2026-09-04T02-28-00Z-e07e`.
 *
 * These are behavioural rather than source-shape assertions on purpose: the
 * defect was not in which function was called, it was in what that function
 * did with its argument.
 */
describe("the trigger reaches a surface adopted by --attach-here", () => {
  const sends = async (paneId: string): Promise<string[][]> => {
    const seen: string[][] = [];
    const backend = new CmuxBackend({
      exec: async (argv): Promise<ExecResult> => {
        seen.push(argv);
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    await backend.sendText({ backend: "cmux", id: paneId }, STAGED_TRIGGER_LINE);
    return seen;
  };

  test("a BARE surface id types the trigger at that surface", async () => {
    const seen = await sends("5C9D22AC-543A-4B1A-A2E6-6555573DB407");
    const send = seen.find((argv) => argv.includes("send-text") || argv.includes("send"));
    expect(send).toBeDefined();
    expect(send!).toContain("5C9D22AC-543A-4B1A-A2E6-6555573DB407");
  });

  test("a full composed id still types at the SURFACE, not the pane", async () => {
    // The widening must not have changed which field a 3-part id sends to.
    const seen = await sends("pane-1 surface-2 workspace-3");
    const send = seen.find((argv) => argv.includes("send-text") || argv.includes("send"));
    expect(send!).toContain("surface-2");
    expect(send!).not.toContain("pane-1");
  });

  test("sendKey reaches a bare surface too, so the trigger can be submitted", async () => {
    // Typing the line and never pressing enter leaves it unsent — both halves
    // of the trigger have to survive the same id.
    const seen: string[][] = [];
    const backend = new CmuxBackend({
      exec: async (argv): Promise<ExecResult> => {
        seen.push(argv);
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    await backend.sendKey({ backend: "cmux", id: "surface-only" }, "enter");
    expect(seen.some((argv) => argv.includes("surface-only"))).toBe(true);
  });

  test("focus refuses a bare surface BY NAME, rather than typing somewhere", async () => {
    // `focus-pane` addresses a pane, and an adopted surface has none recorded.
    // The refusal has to say that; a generic parse error is what sent this
    // whole class of failure to the wrong layer for months.
    const backend = new CmuxBackend({
      exec: async (): Promise<ExecResult> => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    });
    await expect(backend.focus({ backend: "cmux", id: "surface-only" })).rejects.toThrow(
      /--attach-here/,
    );
  });
});

describe("the session is cleared before a staged task starts", () => {
  const src = () =>
    Bun.file(new URL("../../src/cli/commands/dispatch.ts", import.meta.url).pathname).text();
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /**
   * **The ORDER is the property, not the presence.** Reset after the trigger
   * would clear the turn that was just started — a worker that looks triggered,
   * settles nothing, and reports no error. Asserted on the code with comments
   * stripped, because the docblock beside it discusses both orderings.
   */
  test("the reset is typed BEFORE the trigger, not after", async () => {
    const body = code((await src()).slice((await src()).indexOf("async function sendStagedTrigger")));
    /*
     * On the SEND CALLS, not on any mention of the constants. The first version
     * of this test searched for the bare names and did not redden when the two
     * sends were swapped — `STAGED_TRIGGER_LINE` appears again below in the
     * "type this at your terminal" refusal, so "an occurrence after the reset"
     * was true either way. A degenerate assertion in the test that exists to
     * catch the ordering is worse than no test, and the mutation is what found
     * it rather than a reading.
     */
    const reset = body.indexOf("sendText(pane, SESSION_RESET_LINE)");
    const trigger = body.indexOf("sendText(pane, STAGED_TRIGGER_LINE)");
    expect(reset).toBeGreaterThan(-1);
    expect(trigger).toBeGreaterThan(-1);
    expect(trigger).toBeGreaterThan(reset);
  });

  /**
   * `/new` is interactive-mode's own command and reaches `newSession` through
   * the only context that has it. Measured 2026-09-07: an extension cannot —
   * `EVENT_CTX newSession=no`, `COMMAND_CTX newSession=YES`, and the API has no
   * `executeCommand`. If this string changes, it stops being a command and
   * becomes four characters of user text the model reasons about.
   */
  test("the reset line is the command, exactly, and one line", () => {
    expect(SESSION_RESET_LINE).toBe("/new");
    expect(SESSION_RESET_LINE.includes("\n")).toBe(false);
  });

  /**
   * THE NEGATIVE ARM, and it is the one worth having. The staged route's whole
   * safety claim is that a brief never reaches a terminal; the set is what makes
   * that structural rather than a matter of each call site passing a constant.
   */
  test("a brief line is refused by the staged route's gate", () => {
    expect(() => assertHostAuthoredPaneLine("x", "rm -rf / # from a worker's brief")).toThrow(
      /HOST_AUTHORED_PANE_LINES/,
    );
    // …and both host lines are accepted, so the gate is not vacuously closed.
    expect(() => assertHostAuthoredPaneLine("x", SESSION_RESET_LINE)).not.toThrow();
    expect(() => assertHostAuthoredPaneLine("x", STAGED_TRIGGER_LINE)).not.toThrow();
    expect(HOST_AUTHORED_PANE_LINES.size).toBe(2);
  });
});
