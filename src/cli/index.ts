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

/**
 * Classify a thrown value into a ladder code.
 *
 * Exported because this expression IS the entry point's policy, and a test
 * that re-declared it would prove only that its own copy is self-consistent
 * (the same reason `requestedEpochFrom` is exported from `commands/dispatch.ts`).
 *
 * Order matters: a `CommanderError` carries `exitCode: 1`, which satisfies the
 * structural `ExitCoded` protocol and is not a ladder code at all, so commander
 * is classified first.
 */
export function exitCodeForError(err: unknown): ExitCode {
  // `--help` and `--version` arrive here as CommanderErrors after commander has
  // already printed; they are successes, not failures. Everything else
  // commander diagnoses is a usage error. Detected structurally so the
  // commander import stays an implementation detail of this file.
  if (isCommanderError(err)) {
    return err.code === "commander.helpDisplayed" ||
      err.code === "commander.help" ||
      err.code === "commander.version"
      ? EXIT.SUCCESS
      : EXIT.USAGE;
  }
  // One branch: CliError satisfies ExitCoded structurally, so the protocol is
  // the only path and is therefore actually exercised.
  if (isExitCoded(err)) return err.exitCode;
  // Undiagnosed: a bug in pifleet, not a mistake by its caller. Reporting it as
  // EXIT.USAGE collapsed the two into one integer (ISC-216).
  return EXIT.INTERNAL;
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
    import("./commands/tui.ts"),
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
    const code = exitCodeForError(err);
    // Commander already printed its own diagnosis; anything else gets one line
    // and never a stack trace. An undiagnosed failure says so, because the
    // reader's next move differs: file a bug, do not fix the command line.
    if (!isCommanderError(err)) {
      const what = code === EXIT.INTERNAL ? "internal error: " : "";
      process.stderr.write(
        `pifleet: ${what}${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return code;
  }
}

if (import.meta.main) {
  process.exitCode = await main(process.argv);
}
