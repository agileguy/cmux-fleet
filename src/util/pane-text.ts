/**
 * What can be typed into a pane as LITERAL TEXT (SRD §3.5, TUI spec item 10).
 *
 * This rule lives in `util/` rather than beside the cmux client because two
 * callers on opposite sides of a seam need it and neither may import the other:
 * `backends/cmux/client.ts` ENFORCES it as it builds `cmux send`'s argv, and
 * `cli/commands/dispatch.ts` GATES on it before typing the first byte of a
 * multi-line prompt. ISC-137 forbids anything outside `src/backends/cmux/` from
 * importing a cmux module — a real constraint, and the alternative to obeying
 * it here was two copies of the predicate drifting apart.
 *
 * ## The rule is the union of what every pane backend can carry, which is
 * cmux's, because cmux's is the strictest measured
 *
 * Two independent hazards, both measured on 2026-08-31, both of which end in
 * the same silent failure: a fragment of the operator's prompt submitted as a
 * turn, the rest left as unsent keystrokes, and every exit code 0.
 *
 * **1. A real newline byte submits. Universal, not cmux's doing.** Measured
 * against the REAL Pi TUI (v0.79.6, the shipped worker image, a cmux pane
 * running `docker attach`): argv text `ARMB first line<LF>ARMB second line`
 * left `ARMB second line` sitting alone in Pi's prompt box. A pty's Enter is a
 * newline byte; any line-oriented reader behaves this way, so no backend can
 * carry one as data.
 *
 * **2. The two-character sequence `\n` also submits. This one is cmux's.**
 * `cmux send --help` states it — *"Escape sequences: \n and \r send Enter, \t
 * sends Tab"* — and there is no literal mode and no escape that survives.
 * Measured with exact argv bytes, one fresh pane per arm, against a pane
 * reading LINES:
 *
 *   `A\nB`      ->  pane receives `A`, ENTER, `B`
 *   `A\\nB`     ->  pane receives `A\`, ENTER, `B`   (`\\` -> `\`, then `\n`)
 *   `A\\\nB`    ->  pane receives `A\`, ENTER, `B`
 *   `A\xB`      ->  pane receives `A\xB` literally   (unknown escape, inert)
 *
 * Escaping the escape re-creates it, because the substitution runs after the
 * backslash unescaping. Confirmed against the real Pi TUI: text
 * `ARMC first line\nARMC second line` left `ARMC second line` in the box.
 *
 * That second hazard is the nastier one and the reason this predicate exists at
 * all. The text never contains a newline, so a control-character check does not
 * see it — and `\n` appears in ordinary briefs constantly: any code sample, any
 * regex, any "join the lines with \n" instruction.
 *
 * A backslash before any OTHER letter is left alone. Refusing every backslash
 * would be a guard wider than its evidence, and `A\xB` was measured arriving
 * intact.
 *
 * ## What it does NOT rule on
 *
 * A leading `-`. That is an ARGV hazard, not a pane hazard — `cmux send` can
 * consume the text as a flag (measured: `cmux send --surface <id> "--json"`
 * answers `Error: send requires text`, exit 1, nothing reaches the pane) — and
 * it is closed by the `--` separator in `sendArgv` rather than by a refusal.
 * Keeping it out of this predicate is deliberate: a prompt typed into a pane is
 * markdown, and `- item` is a bulleted line, so a rule that refused one here
 * would refuse every task carrying `acceptance` entries.
 *
 * The 1024-character cap is inherited from `assertCmuxText`, which has applied
 * it to every other free-text value this system sends to a pane backend since
 * that module was written. It is a cap on ONE LINE, not on a prompt: a
 * multi-line prompt is sent a line at a time.
 */
export function assertPaneTypeableLine(what: string, v: string): void {
  if (v.length === 0 || v.length > 1024 || /[\x00-\x1f\x7f]/.test(v)) {
    throw new Error(
      `refusing ${what} ${JSON.stringify(v.slice(0, 64))} — empty, over 1024 characters, or carrying control characters`,
    );
  }
  if (/\\[nrt]/.test(v)) {
    throw new Error(
      `refusing ${what} ${JSON.stringify(v.slice(0, 64))} — a pane turns \\n and \\r into Enter and \\t into Tab, ` +
        `so this text would submit a fragment and leave the rest unsent`,
    );
  }
}

/**
 * The key names a pane dispatch may send, and why this is a list rather than a
 * grammar.
 *
 * ## Found live, on the cmux path, after the tmux one was already fixed
 *
 * `dispatch` separates a prompt's lines with `shift+enter` and terminates it
 * with `enter`. Measured 2026-08-31 against a real cmux surface, with the
 * rejected arm as the control:
 *
 *   cmux send-key <surface> shift+enter   rc=0  OK
 *   cmux send-key <surface> enter         rc=0  OK
 *   cmux send-key <surface> S-Enter       rc=1  invalid_params: Unknown key
 *
 * So `shift+enter` is right for cmux and `S-Enter` is right for tmux — the two
 * backends genuinely disagree, which is what `backends/tmux/argv.ts` translates.
 *
 * The defect was upstream of both. `assertCmuxValue` guards every value that
 * rides cmux's argv against flag injection with `^[A-Za-z0-9][A-Za-z0-9:._-]*$`
 * — a grammar that has no `+` in it, because until this mode existed no cmux
 * value needed one. It refused `shift+enter` before the key ever reached cmux,
 * and refused it at STEP 2 OF 29: two lines of the operator's prompt were
 * already in the pane and could not be withdrawn.
 *
 * ## An allow-list, not a widened character class
 *
 * The obvious repair is to add `+` to `CMUX_VALUE_RE`. That is refused: the
 * regex guards surface ids, workspace refs and status keys too, and widening it
 * for a key would widen it for all of them. The hazard it exists to stop —
 * a value parsed as a flag — is not specific to keys.
 *
 * A closed list also gets something a grammar cannot: an unknown key FAILS
 * rather than being forwarded. `backends/tmux/argv.ts` records why that matters
 * — tmux exits 0 on an unknown key name and types it as literal text — so a
 * permissive key rule reintroduces that defect on the other backend.
 *
 * Lives here for the same reason `assertPaneTypeableLine` does: `dispatch.ts`
 * gates on it before typing the first byte and `backends/cmux/client.ts`
 * enforces it as a backstop, and ISC-137 forbids the first from importing the
 * second. One definition, so the gate cannot become laxer than the backstop.
 */
export const PANE_KEYS: readonly string[] = ["enter", "shift+enter", "escape", "tab"];

export function assertPaneKey(what: string, v: string): void {
  if (!PANE_KEYS.includes(v)) {
    throw new Error(
      `refusing ${what} ${JSON.stringify(v.slice(0, 64))} — not a pane key. ` +
        `Known: ${PANE_KEYS.join(", ")}`,
    );
  }
}

/**
 * The line pifleet types to start a staged task — and the reason it begins with
 * `#`.
 *
 * ## What is being defended against
 *
 * `SRD-TUI-DISPATCH` §4.3 argued that an adopted terminal must never be typed
 * into, because `docker attach --detach-keys=ctrl-]` makes detach one keypress
 * pifleet cannot observe. Detach, and the pane's `up --attach-here` exits, and
 * what is left on that surface is the operator's own SHELL. Anything sent after
 * that moment is a shell command.
 *
 * The owner reversed that decision on 2026-09-02, and the design that came back
 * shrinks the exposure rather than accepting it: the BRIEF goes through
 * `/policy/dispatch`, read-only and unwritable by the worker, and never touches
 * the terminal at all. Only this line does.
 *
 * ## `#` first, and what it actually buys
 *
 * In `bash`, `sh` and any POSIX shell, a line beginning `#` is a comment: the
 * payload is not executed. In interactive `zsh`, `INTERACTIVE_COMMENTS` is off
 * by default, so the same line is a parse error — `zsh: bad pattern` or
 * `command not found: #` — which is a NOISY FAILURE and not an execution.
 * Either way the words after the `#` cannot run.
 *
 * **It is a mitigation, not a guarantee, and the difference is worth stating.**
 * It does not survive a shell configured with `interactive_comments` and a
 * history-expansion quirk, it does nothing about a pane respawned onto some
 * third program that treats `#` as input, and it cannot make a misdirected
 * keystroke correct. What it does is convert the worst outcome §4.3 named —
 * arbitrary text from a run's brief executed as host commands — into a comment
 * or an error. The brief is not here to be executed; that is the larger half of
 * the answer, and this is the smaller half that covers the line that is.
 *
 * Pi reads it as ordinary text, because it is: a leading `#` is a markdown
 * heading and carries no special meaning in a composer.
 */
export const STAGED_TRIGGER_LINE =
  "# pifleet: a task was staged for you — read /policy/dispatch and do what it says";

/**
 * Clear the pane's session before a staged task is triggered.
 *
 * ## Why this is typed at a pane and not called through the extension API
 *
 * `newSession()` is the capability wanted, and it is **unreachable from an
 * extension**. Measured 2026-09-07 against the pinned image, three ways:
 *
 *   EVENT_CTX    newSession=no   compact=YES   ← what `pi.on(...)` handlers get
 *   COMMAND_CTX  newSession=YES  compact=YES   ← what a command handler gets
 *   ExtensionAPI executeCommand=undefined, runCommand=undefined
 *
 * So an extension cannot reach it from an event, cannot reach it from a shortcut
 * (`interactive-mode.js`'s shortcut `createContext()` builds `abort`, `compact`
 * and `shutdown` and no more), and has no API with which to invoke its own
 * registered command. `sendUserMessage` cannot carry it either — it calls
 * `prompt()` with `expandPromptTemplates: false` *"to skip command handling"*
 * (`agent-session.js:1013`), so `/new` sent that way arrives as four characters
 * of user text and the model reasons about them.
 *
 * `newSession` lives in interactive-mode's `commandContextActions`. The only
 * caller that can reach it is the TUI's own command input — which is a PANE, and
 * a pane is something this host can already type into.
 *
 * ## What it buys, and the problem it actually solves
 *
 * A `pane_mode: tui` worker keeps its session across dispatches, so a standing
 * console accumulates every task of the day into one transcript and a model
 * holding the last four answers the cheapest way it can — from what it already
 * has. `fresh-dispatch.ts` records the measured case. The existing remedy is a
 * container recycle, and that remedy is unavailable to exactly the workers that
 * need it most: §6.6's recycle is a HEADLESS `up`, which cannot recreate a pane,
 * so a tui console that recycles tears its seats down and cannot bring them back.
 * This is the same freshness without the teardown.
 *
 * ## `#` does not protect this one, and that is stated rather than glossed
 *
 * {@link STAGED_TRIGGER_LINE} is inert in a shell because it begins `#`. THIS
 * LINE IS NOT, and the hazard it is exposed to is the same one: `docker attach
 * --detach-keys` makes detach a single keypress pifleet cannot observe, and after
 * it — or after the container exits — the surface hosts the operator's own shell.
 *
 * What happens to `/new` there is a NOISY FAILURE and not an execution. It names
 * an absolute path that does not exist, so `bash` answers `No such file or
 * directory` and `zsh` answers `no such file or directory: /new`. It takes no
 * arguments, expands nothing, and cannot be a prefix of anything else, because
 * it is the whole line. That is a weaker guarantee than a comment and a stronger
 * one than arbitrary text, and it is the reason this constant is a CONSTANT
 * rather than a parameter — see {@link assertHostAuthoredPaneLine}.
 */
export const SESSION_RESET_LINE = "/new";

/**
 * Every line the STAGED-TRIGGER route may type, as a closed set.
 *
 * ## Scoped to that route, and the scope is not a detail
 *
 * This is NOT "every line this host may type at a surface", and the first draft
 * of this docblock said that and was wrong. `paneKeystrokes` (`dispatch.ts:382`,
 * live at `:597`) turns a rendered prompt into N text sends and types it line by
 * line — arbitrary, worker-visible brief text, guarded by
 * {@link assertPaneTypeableLine} alone, because what it types cannot be a closed
 * set and never could be.
 *
 * That is the backend-managed route. The STAGED route is the one whose claim is
 * that a brief never goes near a terminal (`relay.ts:2362`), and it is the only
 * route this set governs. Two routes, two standards, and conflating them would
 * either strangle the first or grant the second more than it has earned.
 *
 * ## The rule was real and lived nowhere
 *
 * `relay.ts:2362` argues that what may land in a shell is `STAGED_TRIGGER_LINE`
 * *"rather than a markdown brief delivered line by line"* — and that was true by
 * CONVENTION, held up by each call site passing a constant. Nothing checked it.
 * A second line to type is exactly the edit that turns a convention into a
 * regression, so the rule is written down here on the way in.
 *
 * `assertPaneTypeableLine` is unchanged and still applies: it rules on what a
 * pane does to a string (control characters, `\n` becoming Enter, the 1024-char
 * cap). This is the other question — whether the HOST authored the string at all
 * — and the two are deliberately separate predicates, because a future line will
 * need both answers and only one of them is about the text.
 */
export const HOST_AUTHORED_PANE_LINES: ReadonlySet<string> = new Set([
  STAGED_TRIGGER_LINE,
  SESSION_RESET_LINE,
]);

/**
 * {@link assertPaneTypeableLine}, plus: the host wrote this, not a worker.
 *
 * The refusal names the set rather than the offending value, because the value
 * is the thing that must not be echoed if it ever turns out to be a brief.
 */
export function assertHostAuthoredPaneLine(what: string, v: string): void {
  assertPaneTypeableLine(what, v);
  if (!HOST_AUTHORED_PANE_LINES.has(v)) {
    throw new Error(
      `refusing to type ${what} at a pane — only the ${HOST_AUTHORED_PANE_LINES.size} host-authored ` +
        `lines in HOST_AUTHORED_PANE_LINES may reach a surface, and this is not one of them. ` +
        `A surface is not reliably the agent: after a detach or a container exit it is the ` +
        `operator's own shell.`,
    );
  }
}

/**
 * What the auto-trigger extension sends when a staged brief appears (§9 Q4).
 *
 * ## Two copies, on purpose, with a test holding them equal
 *
 * The string also appears in `docker/pi-extensions/dispatch-trigger.ts`, which
 * cannot import it: that file is copied into the image and executed by Pi
 * inside a container where `src/` does not exist. So the agreement is the
 * `THEMES_DIR` shape one level down —
 *
 *     AUTO_TRIGGER_TEXT (here)  ←test→  the extension's own literal  ←build→  the image
 *
 * — and `test/unit/auto-trigger.test.ts` asserts the first arrow by reading the
 * extension off disk. **The drift this prevents is silent in the direction that
 * matters.** If the extension's text changed and this did not, the extension
 * would still fire, the turn would still start, and only `attributedToStage`
 * below would quietly stop recognising it — so every staged turn would fall
 * back to §9 Q1's approximation while every surface kept reporting success.
 *
 * ## Why it is not `STAGED_TRIGGER_LINE`
 *
 * That constant is shaped by a constraint that does not exist here — it must be
 * inert if it lands in a SHELL, hence the leading `#` — and this text never
 * touches a terminal, so the `#` would be a mitigation whose reason had
 * evaporated. The two routes also have to stay TELLABLE APART in the
 * transcript, which is precisely what `attributedToStage` is for; one shared
 * string would collapse the distinction it exists to make.
 */
export const AUTO_TRIGGER_TEXT =
  "pifleet auto-trigger: a task was staged for you. Read /policy/dispatch and do what it says.";
