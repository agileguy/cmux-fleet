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
