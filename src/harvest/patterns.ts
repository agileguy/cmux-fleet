/**
 * Which harness globs a HARVEST grades against (ISC-232).
 *
 * `harvest/index.ts` states the rule this module enforces: a harvester must
 * never resolve its own config from the cwd. It is handed a run directory, not
 * a workspace, and a run outlives the config that produced it — so resolving
 * `./fleet.yaml` at harvest time grades an old run against whatever file
 * happens to be sitting in the current directory today.
 *
 * That is not a theoretical complaint. `resolveConfigPath` falls through to
 * `./fleet.yaml` and then to a machine-global `~/.config/pifleet/fleet.yaml`,
 * so `artifacts` and `report` invoked with no `--config` were doing exactly
 * what the module forbids: a run harvested months ago under the built-in
 * defaults gets re-graded today against whatever the cwd offers, and a task
 * the ISC-150 cap had refused to certify comes back `success` — with no change
 * to the run, the diff, or the code. Purely a function of when and where the
 * command was typed. A verdict that depends on the harvester's cwd is not a
 * verdict.
 *
 * So the harvest path does not auto-discover. Two sources only:
 *
 *  1. An explicit `--config <path>`. The operator named a file and meant it;
 *     this is the escape hatch for a run that predates persistence and for
 *     previewing how a candidate config would grade. Errors are fatal here,
 *     not degraded — a named-but-unusable config is the one case where intent
 *     is unambiguous, and answering it with the defaults would ignore it.
 *
 *  2. Otherwise the value `up` wrote into the run directory when the run was
 *     created — the same technique `run.json`'s `heartbeat_interval_ms`
 *     already uses so a config edited mid-run cannot retroactively change how
 *     the run is reaped.
 *
 * Neither reads the cwd, which is what makes the guarantee hold: harvesting
 * the same run twice, on different days, from different directories, with a
 * different `fleet.yaml` in each, produces the same harness surface both
 * times. Cwd and `~/.config` discovery still reach `up`, `doctor`, `render`
 * and `config` — commands that act on a workspace in the present tense, where
 * "the config in front of me" is the right answer.
 */

import { loadConfig } from "../config/load.ts";
import { readRunHarnessPatterns } from "../run/state.ts";
import type { RunPaths } from "../run/paths.ts";

export interface ResolvedHarnessPatterns {
  /** `undefined` = the harvester's built-in defaults apply. */
  patterns: readonly string[] | undefined;
  /**
   * Degradations — things that went wrong on the way to the answer. Empty on
   * the happy path, and each one is worth a `warning:` on stderr.
   */
  warnings: string[];
  /**
   * The plain statement of which surface was used, always present.
   *
   * Not a warning and not conditional: "what did you grade against" is worth
   * saying when nothing went wrong. `artifacts` publishes the answer as
   * `facts.harness.patterns` in its payload already; `report` had no
   * equivalent anywhere, so a consumer of `report --json` could not tell a
   * defaults grading from a config one at all.
   */
  surface: string;
}

/**
 * Resolve the surface for one harvest of one run.
 *
 * Throws `ConfigError` (exit `USAGE`) only for an explicit `--config` that
 * cannot be resolved, read, or parsed. Every other path degrades to the
 * built-in defaults with a note, because `artifacts` and `report` are pure
 * reads over a run directory and must keep working for a run whose config has
 * moved on.
 */
export async function resolveHarnessPatterns(
  run: RunPaths,
  explicitConfig?: string,
): Promise<ResolvedHarnessPatterns> {
  if (explicitConfig !== undefined) {
    const loaded = await loadConfig(explicitConfig);
    const patterns = loaded.config.harness.patterns;
    return {
      patterns,
      warnings: [],
      surface:
        patterns === undefined
          ? `harness surface: built-in defaults (${loaded.path} sets no harness.patterns)`
          : `harness surface: ${patterns.length} pattern(s) from ${loaded.path}, overriding what this run recorded`,
    };
  }

  const recorded = await readRunHarnessPatterns(run);
  return {
    patterns: recorded.patterns,
    warnings: recorded.note === null ? [] : [recorded.note],
    surface:
      recorded.patterns === undefined
        ? "harness surface: built-in defaults"
        : `harness surface: ${recorded.patterns.length} pattern(s) recorded in this run's run.json`,
  };
}
