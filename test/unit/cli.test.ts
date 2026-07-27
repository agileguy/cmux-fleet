import { describe, expect, test } from "bun:test";
import { buildProgram, CliError } from "../../src/cli/index.ts";
import { EXIT, isExitCoded } from "../../src/contracts.ts";

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
