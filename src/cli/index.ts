#!/usr/bin/env bun
/**
 * `pifleet` entry point.
 *
 * Commands live one-per-file under `src/cli/commands/` and are registered here.
 * Each module exports `register(program)`; the entry point owns argument parsing,
 * the exit-code ladder, and nothing else, so two commands never share a file.
 */

import { Command } from "commander";
import { EXIT, type ExitCode, isExitCoded } from "../contracts.ts";

/**
 * Thrown by a command to exit with a specific ladder code and a clean message.
 *
 * The field is `exitCode`, not `code`, so that `CliError` satisfies the
 * structural `ExitCoded` protocol in contracts.ts. It previously did not, and
 * the ladder worked only because the `instanceof` branch below runs first —
 * meaning the structural path the protocol exists to provide was exercised by
 * nothing, and any module-identity split (a duplicated import, a bundling
 * boundary) would have demoted every CLI error to exit 1 plus a stack trace.
 */
export class CliError extends Error {
  constructor(
    message: string,
    readonly exitCode: ExitCode = EXIT.USAGE,
  ) {
    super(message);
    this.name = "CliError";
  }
}

/** A commander-thrown error: has a dotted `commander.*` code and was printed already. */
function isCommanderError(e: unknown): e is { code: string; exitCode: number } {
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { code?: unknown }).code === "string" &&
    (e as { code: string }).code.startsWith("commander.")
  );
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("pifleet")
    .description("Orchestrate a fleet of containerized Pi coding agents")
    .version("0.1.0")
    .showHelpAfterError()
    // Without this commander calls process.exit(1) itself, so the most common
    // error in the whole CLI — a typo'd flag or an unknown subcommand — never
    // reached the ladder and exited 1, a code the SRD §10 ladder does not
    // define. exitOverride routes it through main()'s catch instead.
    .exitOverride()
    .enablePositionalOptions();
  return program;
}

async function main(argv: string[]): Promise<number> {
  const program = buildProgram();

  // Registration order is the order commands appear in `--help`.
  const modules = await Promise.all([
    import("./commands/doctor.ts"),
    import("./commands/image.ts"),
    import("./commands/config.ts"),
    import("./commands/render.ts"),
    import("./commands/up.ts"),
    import("./commands/daemon.ts"),
    import("./commands/status.ts"),
    import("./commands/dispatch.ts"),
    import("./commands/steer.ts"),
    import("./commands/abort.ts"),
    import("./commands/wait.ts"),
    import("./commands/artifacts.ts"),
    import("./commands/transcript.ts"),
    import("./commands/harvest.ts"),
    import("./commands/report.ts"),
    import("./commands/attach.ts"),
    import("./commands/logs.ts"),
    import("./commands/exec.ts"),
    import("./commands/down.ts"),
  ]);
  for (const m of modules) m.register(program);

  // No subcommand at all did nothing and reported success. Naming no command
  // is a usage error, and an orchestrator switching on the integer has to be
  // able to tell "did nothing" from "succeeded".
  if (argv.length <= 2) {
    program.outputHelp();
    return EXIT.USAGE;
  }

  try {
    await program.parseAsync(argv);
    return EXIT.SUCCESS;
  } catch (err) {
    // `--help` and `--version` reach here as CommanderErrors after commander
    // has already printed; they are successes, not failures. Everything else
    // commander diagnoses is a usage error. Detected structurally so the
    // commander import stays an implementation detail of this file.
    if (isCommanderError(err)) {
      return err.code === "commander.helpDisplayed" ||
        err.code === "commander.help" ||
        err.code === "commander.version"
        ? EXIT.SUCCESS
        : EXIT.USAGE;
    }
    // One branch: CliError satisfies ExitCoded structurally, so the protocol
    // is the only path and is therefore actually exercised.
    if (isExitCoded(err)) {
      process.stderr.write(`pifleet: ${err.message}\n`);
      return err.exitCode;
    }
    // Undiagnosed. Still no stack trace on stderr and still a ladder code:
    // exit 1 is not in the SRD §10 ladder, so a caller switching on the
    // integer would fall through every case it knows about.
    process.stderr.write(`pifleet: ${err instanceof Error ? err.message : String(err)}\n`);
    return EXIT.USAGE;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv);
}
