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
import {
  STAGED_TRIGGER_LINE,
  assertPaneTypeableLine,
  PANE_KEYS,
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
