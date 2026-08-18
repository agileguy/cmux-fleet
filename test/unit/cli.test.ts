import { describe, expect, test } from "bun:test";
import { buildProgram, CliError, exitCodeForError } from "../../src/cli/index.ts";
import { EXIT, isExitCoded, worstExit } from "../../src/contracts.ts";

/** Every command named in SRD §10's CLI surface table. */
const SRD_COMMANDS = [
  "doctor",
  "image",
  "config",
  "render",
  "up",
  "daemon",
  "status",
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
] as const;

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
