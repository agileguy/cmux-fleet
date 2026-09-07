import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { buildProgram, CliError, exitCodeForError } from "../../src/cli/index.ts";
import { EXIT, isExitCoded, worstExit } from "../../src/contracts.ts";

/**
 * The commands this file drives, registers, and holds to SRD §10's `--json` rule.
 *
 * **It is not "every command named in SRD §10", which is what this comment used
 * to say, and the gap is measured rather than assumed** (2026-09-06, SRD-
 * TRIAGE-CONSOLE §13 task 6.2). §10's table names twenty-six commands; this set
 * holds twenty. `monitor`, `pm-guard`, `relay`, `unstage`, `tui` and `shell` each
 * have a §10 row and are absent here — see {@link EXCLUDED_COMMANDS}, which now
 * says so out loud instead of leaving it to whoever counts the rows.
 */
const SRD_COMMANDS = [
  "doctor",
  "image",
  "config",
  "render",
  "up",
  "daemon",
  "status",
  "worktrees",
  "dispatch",
  "steer",
  "abort",
  "wait",
  "artifacts",
  "transcript",
  "harvest",
  "report",
  "attach",
  "logs",
  "exec",
  "down",
  /**
   * SRD-TRIAGE-CONSOLE §13 task 6.2, and the direction was FORCED rather than
   * chosen — see {@link EXCLUDED_COMMANDS}.
   */
  "triage",
] as const;

/**
 * Command modules deliberately NOT driven by {@link SRD_COMMANDS}, each with the
 * mechanism rather than a verdict.
 *
 * ## Why this list exists at all
 *
 * Until 2026-09-06 the exclusion was by OMISSION: `registeredCommands` imports
 * only `SRD_COMMANDS`, so a module absent from that array was never registered
 * and the bidirectional assertion below said nothing whatever about it. Six
 * modules were excluded that way, silently, and nothing anywhere recorded that
 * they were — so "is this command missing on purpose?" had no answer short of
 * reading `src/cli/index.ts` and diffing it by eye.
 *
 * SRD-TRIAGE-CONSOLE §13 task 6.2 requires the seventh — `triage` — to be settled
 * *"in one direction or the other"*, and §12 states the reason the choice cannot
 * be ducked: **"the set is asserted in both directions, so silence is not an
 * option."** An omission IS silence. So the omission is written down, given a
 * reason apiece, and — in the test below — made structural: every command module
 * on disk must appear in exactly one of the two lists, which is what stops the
 * eighth exclusion from being silent the way the first six were.
 *
 * ## Which direction `triage` took, and why it was not a choice
 *
 * §13 offers two: *"either the set gains `triage` and `Docs/SRD.md` §10 gains its
 * row, or the exclusion list does and this console has its own importer test."*
 * It reads as a free choice and it is not one, because a THIRD test decides it.
 *
 * `test/unit/docs-currency.test.ts`'s *"every registered command appears in §10"*
 * enumerates `src/cli/commands/*.ts` and greps each file for
 * `program.command("…")` — the FILE is what makes a command registered, by that
 * test's own definition, not an entry in `src/cli/index.ts` and not an entry
 * here. So `src/cli/commands/triage.ts` existing at all requires a `Docs/SRD.md`
 * §10 row, and the second direction does not avoid the Docs edit; it only leaves
 * §10 naming `triage` while this set does not, which is precisely the
 * inconsistency the six rows above document as a defect.
 *
 * So: the first direction. `Docs/SRD.md` §10's row is owed by whoever owns
 * `Docs/` and `test/unit/docs-currency.test.ts` is RED until it lands — that is a
 * reported handoff, not an oversight. `test/unit/triage-command.test.ts` exists
 * regardless, because §12 asks for the in-process importer test on its own
 * merits.
 */
const EXCLUDED_COMMANDS: Readonly<Record<string, string>> = {
  monitor:
    "has a §10 row; driven by test/unit/monitor-*.test.ts and its own read-only closure guard.",
  "pm-guard":
    "has a §10 row (two, in fact); driven in-process by test/unit/pm-guard-command.test.ts, " +
    "which exists because this layer fell out of the coverage report once already.",
  relay:
    "has a §10 row; the review console's actor, driven by test/unit/collator-relay-adapter.test.ts.",
  unstage:
    "has a §10 row; releases a STAGED epoch, deliberately not `abort` (SRD-TUI-DISPATCH §9 Q8).",
  tui: "has a §10 row; driven in-process by test/unit/tui-command.test.ts.",
  shell:
    "has a §10 row; opens an interactive shell in a container, so it has no non-interactive path " +
    "this suite could drive.",
};

/** Every `src/cli/commands/*.ts` module, which is the population both lists partition. */
function commandModulesOnDisk(): string[] {
  return readdirSync(join(import.meta.dir, "..", "..", "src", "cli", "commands"))
    .filter((n) => n.endsWith(".ts"))
    .map((n) => n.slice(0, -".ts".length))
    .sort();
}

async function registeredCommands(): Promise<Set<string>> {
  const program = buildProgram();
  const modules = await Promise.all(
    SRD_COMMANDS.map((n) => import(`../../src/cli/commands/${n}.ts`)),
  );
  for (const m of modules) (m as { register: (p: typeof program) => void }).register(program);
  return new Set(program.commands.map((c) => c.name()));
}

describe("CLI surface", () => {
  // ISC-14: every SRD §10 command exists.
  test("registers every command in SRD §10", async () => {
    const names = await registeredCommands();
    for (const c of SRD_COMMANDS) expect(names).toContain(c);
  });

  test("registers no command outside SRD §10", async () => {
    const names = await registeredCommands();
    for (const n of names) expect(SRD_COMMANDS as readonly string[]).toContain(n);
  });

  // Every command supports --json (SRD §10).
  test("every command accepts --json", async () => {
    const program = buildProgram();
    const modules = await Promise.all(
      SRD_COMMANDS.map((n) => import(`../../src/cli/commands/${n}.ts`)),
    );
    for (const m of modules) (m as { register: (p: typeof program) => void }).register(program);
    for (const cmd of program.commands) {
      const flags = cmd.options.map((o) => o.long);
      expect(flags).toContain("--json");
    }
  });

  /**
   * **The exclusion is a list, not an omission** (SRD-TRIAGE-CONSOLE §13 task
   * 6.2, §12: *"the set is asserted in both directions, so silence is not an
   * option"*).
   *
   * The two lists must PARTITION the command modules on disk: every module in
   * exactly one, and no entry in either naming a module that is not there. That
   * is the mechanism, and it is what the previous by-omission arrangement lacked
   * — a new `src/cli/commands/whatever.ts` was invisible to this file, so the
   * question this test asks could not previously be asked at all.
   *
   * Disjointness is asserted separately from coverage because the two failures
   * read differently: a name in both lists is a contradiction about intent, and a
   * module in neither is a decision nobody made.
   */
  test("SRD_COMMANDS and EXCLUDED_COMMANDS partition the command modules on disk", () => {
    const onDisk = commandModulesOnDisk();
    const included = new Set<string>(SRD_COMMANDS);
    const excluded = new Set(Object.keys(EXCLUDED_COMMANDS));

    for (const name of included) expect(excluded.has(name)).toBe(false);
    expect([...included, ...excluded].sort()).toEqual(onDisk);
    // Named, not counted: `monitor-readonly.test.ts`'s rule, which is that
    // naming the permitted set is what makes an unlisted member fail.
    expect([...excluded].sort()).toEqual(
      ["monitor", "pm-guard", "relay", "shell", "tui", "unstage"].sort(),
    );
    // `triage` took the FIRST direction and is DRIVEN, not excluded. Asserted
    // here as well as by the partition above, because "settled in one direction
    // or the other" is a claim about which one, and a reader of a red diff needs
    // to see that the answer was not "neither".
    expect(included.has("triage")).toBe(true);
    expect(excluded.has("triage")).toBe(false);
  });

  /** An exclusion that states no mechanism is a verdict, and a verdict rots. */
  test("every exclusion states a reason", () => {
    for (const [name, why] of Object.entries(EXCLUDED_COMMANDS)) {
      expect(why.length, `${name} needs a reason`).toBeGreaterThan(20);
    }
  });
});

describe("CliError", () => {
  test("defaults to the usage exit code", () => {
    expect(new CliError("bad").exitCode).toBe(EXIT.USAGE);
  });

  test("carries an explicit ladder code when given one", () => {
    expect(new CliError("no backend", EXIT.BACKEND_UNAVAILABLE).exitCode).toBe(
      EXIT.BACKEND_UNAVAILABLE,
    );
  });

  /**
   * The entry point routes every diagnosed failure through the structural
   * protocol. CliError naming its field `code` meant it did NOT satisfy that
   * protocol, and the ladder survived only because an `instanceof` branch ran
   * first — leaving the structural path dead and one module-identity split
   * away from demoting every CLI error to exit 1 with a stack trace.
   */
  test("satisfies the structural ExitCoded protocol", () => {
    expect(isExitCoded(new CliError("bad", EXIT.TIMEOUT))).toBe(true);
  });
});

/**
 * ISC-216. The catch-all reused `EXIT.USAGE` for errors it could NOT diagnose,
 * so a bug inside pifleet was indistinguishable — over the only channel a
 * machine caller has — from the operator mistyping a flag. An orchestrator
 * switching on the integer would answer a crash by rewriting its arguments and
 * trying again, forever.
 *
 * The classifier is exported because it IS the expression the entry point
 * evaluates (same reason as `requestedEpochFrom`): a test that re-declares the
 * predicate proves only that its copy is self-consistent.
 */
describe("undiagnosed errors are their own exit code (ISC-216)", () => {
  test("an internal throw is EXIT.INTERNAL, not EXIT.USAGE", () => {
    const bug = new TypeError("undefined is not an object");
    expect(exitCodeForError(bug)).toBe(EXIT.INTERNAL);
    expect(exitCodeForError(bug)).not.toBe(EXIT.USAGE);
  });

  test("a thrown non-Error is undiagnosed too", () => {
    expect(exitCodeForError("kaboom")).toBe(EXIT.INTERNAL);
    expect(exitCodeForError(undefined)).toBe(EXIT.INTERNAL);
  });

  test("a diagnosed failure still carries its own ladder code", () => {
    expect(exitCodeForError(new CliError("no backend", EXIT.BACKEND_UNAVAILABLE))).toBe(
      EXIT.BACKEND_UNAVAILABLE,
    );
    expect(exitCodeForError(new CliError("bad flag"))).toBe(EXIT.USAGE);
  });

  /**
   * Commander's errors are checked FIRST and must stay so: a CommanderError
   * carries `exitCode: 1`, which satisfies the structural ExitCoded protocol
   * and is not a ladder code at all.
   */
  test("commander keeps its own classification: usage, and help/version as success", () => {
    const commanderError = (code: string): unknown => ({ code, exitCode: 1, message: code });
    expect(exitCodeForError(commanderError("commander.unknownOption"))).toBe(EXIT.USAGE);
    expect(exitCodeForError(commanderError("commander.unknownCommand"))).toBe(EXIT.USAGE);
    expect(exitCodeForError(commanderError("commander.helpDisplayed"))).toBe(EXIT.SUCCESS);
    expect(exitCodeForError(commanderError("commander.help"))).toBe(EXIT.SUCCESS);
    expect(exitCodeForError(commanderError("commander.version"))).toBe(EXIT.SUCCESS);
  });

  test("EXIT.INTERNAL is distinct and ranked, so worstExit cannot swallow it", () => {
    expect(EXIT.INTERNAL).not.toBe(EXIT.USAGE);
    // Unranked codes fall out of `worstExit` as SUCCESS — a run that broke
    // would report that it did not.
    expect(worstExit([EXIT.SUCCESS, EXIT.PARTIAL, EXIT.INTERNAL])).toBe(EXIT.INTERNAL);
  });
});
