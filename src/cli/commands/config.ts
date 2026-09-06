import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import {
  ConfigError,
  ConfigValidationError,
  loadConfig,
  resolveAllWorkers,
} from "../../config/load.ts";
import {
  kubeconfigScopeWarning,
  operatorIdentityWarning,
  observerTuiEpochWarning,
  observerTuiWorkers,
  unknownThemeWarning,
  unknownThemeWorkers,
  workersMissingKubeconfig,
} from "../../config/schema.ts";

/**
 * Register `pifleet config` (SRD §10).
 *
 * `config validate` exits 2 on ANY failure (ISC-58) and prints field-level
 * errors — the dotted document path plus the message — because "invalid
 * config" without a path is a debugging session, not a diagnostic.
 */

/**
 * The host's own `git config user.email`, or `null` when there is none.
 *
 * Best-effort by construction: a machine with no git, no global config, or a
 * git that errors is a machine with nothing to collide with, and
 * `operatorIdentityWarning` treats that as "nothing to say". This is the only
 * host lookup `config validate` makes, and it exists because ISC-529's
 * anti-criterion cannot be checked from the document alone — the schema
 * cannot know which address is the operator's.
 */
async function hostGitEmail(): Promise<string | null> {
  try {
    const p = Bun.spawn(["git", "config", "--get", "user.email"], {
      stdout: "pipe",
      stderr: "ignore",
      stdin: "ignore",
    });
    const out = (await new Response(p.stdout).text()).trim();
    return (await p.exited) === 0 && out.length > 0 ? out : null;
  } catch {
    return null;
  }
}

export function register(program: Command): void {
  program
    .command("config <action>")
    .description("Validate the fleet configuration")
    .option("-c, --config <path>", "path to fleet.yaml")
    .option("--json", "emit machine-readable output")
    .action(async (action: string, opts: { config?: string; json?: boolean }) => {
      if (action !== "validate") {
        throw new CliError(`unknown config action "${action}" (expected: validate)`, EXIT.USAGE);
      }
      try {
        const loaded = await loadConfig(opts.config);
        /*
         * ISC-402. Parsing is not validating.
         *
         * `loadConfig` proves the DOCUMENT is well-formed; it does not perform
         * the worker -> role -> defaults merge, so every refusal that can only
         * be seen after that merge was invisible here. `validate` printed `ok:`
         * for a config `up` then refused — an undeclared provider, or a
         * `model:` that decomposes to nothing — which is worse than not having
         * the command, because the operator has been told the file is fine.
         *
         * `resolveAllWorkers` is the merge and nothing else: no Docker, no
         * network, no filesystem beyond the briefing paths already resolved
         * during the parse. It is the same function `up` calls first, so what
         * passes here is exactly what `up` will accept.
         */
        resolveAllWorkers(loaded);
        // Non-fatal (SRD-OBSERVER-001 §6.2, §6.6) — a document that trips
        // these still validates; see `schema.ts` for why each is a warning
        // and not a refusal.
        const warnings = [
          kubeconfigScopeWarning(workersMissingKubeconfig(loaded.config)),
          observerTuiEpochWarning(observerTuiWorkers(loaded.config)),
          unknownThemeWarning(unknownThemeWorkers(loaded.config)),
          operatorIdentityWarning(loaded.config.run.git_identity.email, await hostGitEmail()),
        ].filter((w): w is string => w !== null);
        const summary = {
          valid: true,
          path: loaded.path,
          roles: Object.keys(loaded.config.roles),
          workers: loaded.config.workers.map((w) => w.id),
          warnings,
        };
        if (opts.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log(`ok: ${loaded.path}`);
          console.log(`  roles:   ${summary.roles.join(", ")}`);
          console.log(`  workers: ${summary.workers.join(", ")}`);
        }
        // Stderr regardless of --json, on `unattendedTuiWarning`'s precedent:
        // the JSON stream on stdout stays one object either way.
        for (const w of warnings) process.stderr.write(w);
      } catch (err) {
        // A merge-time refusal carries no field path — it is one sentence
        // naming the worker — so it becomes the same USAGE exit as a schema
        // failure rather than escaping as an internal error (exit 8).
        if (err instanceof ConfigError && !(err instanceof ConfigValidationError)) {
          if (opts.json) {
            console.log(JSON.stringify({ valid: false, errors: [{ path: "", message: err.message }] }, null, 2));
          }
          throw new CliError(err.message, EXIT.USAGE);
        }
        if (err instanceof ConfigValidationError) {
          if (opts.json) {
            console.log(JSON.stringify({ valid: false, path: err.file, errors: err.issues }, null, 2));
          }
          // JSON (when asked) went to stdout; the ladder code and human line
          // ride the CliError so the entry point owns process exit.
          throw new CliError(err.message, EXIT.USAGE);
        }
        throw err;
      }
    });
}
