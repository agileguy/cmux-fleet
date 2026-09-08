import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import {
  ConfigError,
  ConfigValidationError,
  expandPath,
  loadConfig,
  assertModelAllowed,
  resolveAllWorkers,
} from "../../config/load.ts";
import {
  kubeconfigScopeWarning,
  operatorIdentityWarning,
  observerTuiEpochWarning,
  observerTuiWorkers,
  submitReportWriteWarning,
  submitReportWriteWorkers,
  unknownThemeWarning,
  unknownThemeWorkers,
  workersMissingKubeconfig,
} from "../../config/schema.ts";
import {
  triagePaths,
  triageStageSummary,
  triageUnfencedWarning,
  validateTriageFiles,
} from "../../run/triage-config.ts";

/**
 * Register `pifleet config` (SRD §10).
 *
 * `config validate` exits 2 on ANY failure (ISC-58) and prints field-level
 * errors — the dotted document path plus the message — because "invalid
 * config" without a path is a debugging session, not a diagnostic.
 *
 * ## Three files, one command (SRD-TRIAGE-CONSOLE §7.1, §7.8, task 3.5)
 *
 * `fleet.yaml`, `triage/targets.yaml` and `triage/console.yaml` are validated in
 * ONE pass, because §7.8 charges the second and third files' existence against
 * exactly that: *"it costs nothing extra, because both files are validated in
 * the same `config validate` pass."* Split across two commands the cross-file
 * bound has no home — `default_window` lives in one file and `cadence_s` in the
 * other, and a command holding one of them can only guess at the other's
 * default.
 *
 * **This is also the only path along which D11's fence defends anything.** The
 * fence is `triage-targets.ts`'s and was complete before this wiring existed,
 * but until a command called it the console could still have reached an
 * environment nobody wrote down, because nothing in `src/` called the loader at
 * all (ISC-579). `validateTriageFiles` is that call; the policy for a fleet with
 * no inventory and for one with no kubeconfig is argued on `TriageStage`, not
 * here.
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
        const resolved = resolveAllWorkers(loaded);
        /*
         * THE ALLOWLIST, in the same pass and for the block above's own reason.
         *
         * `resolveAllWorkers` is the merge; `assertModelAllowed` is the other
         * refusal `up` makes before it starts anything, and leaving it out broke
         * the promise two paragraphs up. Measured 2026-09-08: `gemma4:31b` was
         * given to `rev-ctx-1` with its `context_windows` entry but WITHOUT its
         * `models_allowlist` line. `config validate` printed `ok:` and listed
         * the worker; `scripts/review --restart` reported the pane respawned;
         * `up` then refused INSIDE that pane, where nothing was reading. The
         * only visible symptom was `status --all` showing eleven workers where
         * there had been twelve — a seat that is simply absent, with the reason
         * on a surface the operator had already looked away from.
         *
         * It costs nothing this command was not already paying: the allowlist
         * is in the document, the worker is resolved one line up, and neither
         * side touches the network. The probe those entries RECORD is another
         * matter and stays `doctor`'s.
         */
        for (const w of resolved) assertModelAllowed(loaded, w);
        /*
         * The other two contracts, in the same pass and against the SAME
         * document that was just merged: the kubeconfig this fence reads is
         * this fleet's `cloud.kubeconfig`, resolved against the config file's
         * own directory on §6.1 rule 3 — the same base every other path in the
         * document uses.
         */
        const triage = await validateTriageFiles({
          paths: triagePaths(loaded.dir),
          kubeconfigPath:
            loaded.config.cloud.kubeconfig === null
              ? null
              : expandPath(loaded.config.cloud.kubeconfig, loaded.dir),
        });
        // Non-fatal (SRD-OBSERVER-001 §6.2, §6.6) — a document that trips
        // these still validates; see `schema.ts` for why each is a warning
        // and not a refusal.
        const warnings = [
          kubeconfigScopeWarning(workersMissingKubeconfig(loaded.config)),
          observerTuiEpochWarning(observerTuiWorkers(loaded.config)),
          submitReportWriteWarning(submitReportWriteWorkers(loaded.config)),
          unknownThemeWarning(unknownThemeWorkers(loaded.config)),
          operatorIdentityWarning(loaded.config.run.git_identity.email, await hostGitEmail()),
          triageUnfencedWarning(triage),
        ].filter((w): w is string => w !== null);
        const summary = {
          valid: true,
          path: loaded.path,
          roles: Object.keys(loaded.config.roles),
          workers: loaded.config.workers.map((w) => w.id),
          // `null` when this fleet has no `triage/targets.yaml` — the absence
          // is reported as a field rather than by omitting the key, so a JSON
          // consumer can tell "no console" from "an older pifleet".
          triage: triageStageSummary(triage),
          warnings,
        };
        if (opts.json) {
          console.log(JSON.stringify(summary, null, 2));
        } else {
          console.log(`ok: ${loaded.path}`);
          console.log(`  roles:   ${summary.roles.join(", ")}`);
          console.log(`  workers: ${summary.workers.join(", ")}`);
          if (summary.triage !== null) {
            const t = summary.triage;
            console.log(
              `  triage:  ${t.targets_path} — ${t.environments.length} environment(s) ` +
                `(${t.environments.join(", ")}), ${t.services} service(s)` +
                `${t.fenced ? "" : ", NOT fenced"}`,
            );
            console.log(
              `           ${t.console_path} — cadence ${t.cadence_s}s, ` +
                `sweep deadline ${t.sweep_deadline_s}s`,
            );
          }
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
