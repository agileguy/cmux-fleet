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

  test("focus scopes focus-pane to the pane's own workspace, not the caller's", async () => {
    // Without `--workspace`, cmux resolves the pane against `$CMUX_WORKSPACE_ID`,
    // so `pifleet attach` run from inside another workspace reports a pane that
    // exists as `not_found` (measured on 0.64.22, 2026-09-13).
    const seen: string[][] = [];
    const backend = new CmuxBackend({
      exec: async (argv): Promise<ExecResult> => {
        seen.push(argv);
        return { code: 0, stdout: "", stderr: "", timedOut: false };
      },
    });
    await backend.focus({ backend: "cmux", id: "pane-1 surf-1 ws-1" });
    const focus = seen.find((argv) => argv.includes("focus-pane"));
    expect(focus, "no focus-pane call").toBeDefined();
    expect(focus!.slice(focus!.indexOf("focus-pane"))).toEqual([
      "focus-pane",
      "--workspace",
      "ws-1",
      "--pane",
      "pane-1",
    ]);
  });

  test("focus refuses a pane recorded without its workspace BY NAME", async () => {
    // The 2-field id a pre-`--workspace` build persisted. Emitting a bare
    // `--pane` for it is the defect above; refusing names the repair.
    const backend = new CmuxBackend({
      exec: async (): Promise<ExecResult> => ({ code: 0, stdout: "", stderr: "", timedOut: false }),
    });
    await expect(backend.focus({ backend: "cmux", id: "pane-1 surf-1" })).rejects.toThrow(
      /no workspace to scope focus-pane to/,
    );
  });
});

describe("the session is cleared AFTER the task settles", () => {
  const src = () =>
    Bun.file(new URL("../../src/cli/commands/dispatch.ts", import.meta.url).pathname).text();
  const code = (text: string): string =>
    text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");

  /**
   * **The trigger types the trigger and nothing else, and that is the property.**
   * A reset typed before the trigger fights three separate decisions — the
   * `auto_trigger` delegation (the host types NOTHING on that path), the turn
   * attribution `attributedToStage` performs on `AUTO_TRIGGER_TEXT` alone, and
   * `wait`'s handling of an armed stage. Asserted on the code with comments
   * stripped, because the docblocks discuss both placements at length.
   */
  test("sendStagedTrigger does not type the session reset", async () => {
    const text = await src();
    const body = code(text.slice(text.indexOf("export async function sendStagedTrigger")));
    expect(body).not.toContain("SESSION_RESET_LINE");
  });

  /**
   * `/new` is interactive-mode's own command and reaches `newSession` through the
   * only context that has it. Measured 2026-09-07: an extension cannot — at
   * `session_start` the handler context reports `newSession=no`, `compact=YES`,
   * and the API has no `executeCommand`. If this string changes it stops being a
   * command and becomes four characters of user text.
   */
  test("the reset line is the command, exactly, and one line", () => {
    expect(SESSION_RESET_LINE).toBe("/new");
    expect(SESSION_RESET_LINE.includes("\n")).toBe(false);
  });

  /**
   * THE NEGATIVE ARM. The staged route's safety claim is that a brief never
   * reaches a terminal; the closed set is what makes that structural rather than
   * a matter of every call site remembering to pass a constant.
   */
  test("a brief line is refused by the staged route's gate", () => {
    expect(() => assertHostAuthoredPaneLine("x", "rm -rf / # from a worker's brief")).toThrow(
      /HOST_AUTHORED_PANE_LINES/,
    );
    expect(() => assertHostAuthoredPaneLine("x", SESSION_RESET_LINE)).not.toThrow();
    expect(() => assertHostAuthoredPaneLine("x", STAGED_TRIGGER_LINE)).not.toThrow();
    expect(HOST_AUTHORED_PANE_LINES.size).toBe(2);
  });

  /**
   * `resetPaneSession` reports rather than throws, and an rpc seat is the
   * ORDINARY case rather than a fault: those seats have no surface and are
   * served by §6.6's recycle, which works for exactly the seats this does not.
   */
  test("a seat with no surface is reported, not thrown", async () => {
    const { resetPaneSession } = await import("../../src/cli/commands/dispatch.ts");
    const noSurface = {
      schema: "pifleet.presentation/v1",
      worker: "rpc-1",
      backend: "headless",
      workspace_ref: null,
      workspace_name: null,
      surface_ref: null,
      window_ref: null,
      adopted_terminal: false,
      surface_backend: null,
      attach_process: null,
    } as unknown as Parameters<typeof resetPaneSession>[1];
    const out = await resetPaneSession(
      "rpc-1",
      noSurface,
      async () => {
        throw new Error("must not load a backend when there is no surface");
      },
    );
    expect(out.reset).toBe(false);
    expect(out.reason).toContain("no addressable surface");
  });
});
