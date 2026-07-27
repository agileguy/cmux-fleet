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

/** Thrown by a command to exit with a specific ladder code and a clean message. */
export class CliError extends Error {
  constructor(
    message: string,
    readonly code: ExitCode = EXIT.USAGE,
  ) {
    super(message);
    this.name = "CliError";
  }
}

export function buildProgram(): Command {
  const program = new Command();
  program
    .name("pifleet")
    .description("Orchestrate a fleet of containerized Pi coding agents")
    .version("0.1.0")
    .showHelpAfterError()
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

  try {
    await program.parseAsync(argv);
    return EXIT.SUCCESS;
  } catch (err) {
    if (err instanceof CliError) {
      process.stderr.write(`pifleet: ${err.message}\n`);
      return err.code;
    }
    // Any module-defined error that declares an exit code is a diagnosed
    // failure and gets the same one-line treatment.
    if (isExitCoded(err)) {
      process.stderr.write(`pifleet: ${err.message}\n`);
      return err.exitCode;
    }
    throw err;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv);
}
