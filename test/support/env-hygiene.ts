/**
 * The suite-level `PIFLEET_*` environment guard (ISC-278).
 *
 * THE PROPERTY: no test file leaves a `PIFLEET_*` variable different at process
 * exit from what it was at process load.
 *
 * WHY IT NEEDS AN EXTERNAL OBSERVER, WHICH IS THE ENTIRE REASON THIS FILE
 * EXISTS. The defect this closes is invisible to the suite in BOTH states.
 * `test/unit/tui-command.test.ts` leaked `PIFLEET_RUNS_DIR` to process exit
 * pointing at a directory its own `afterAll` had already deleted, and it passed
 * 7/7 before the fix and 7/7 after it. Nothing in 55 test files went red, and
 * nothing would have — there is no assertion a test file can make about the
 * state of the process AFTER every test file has finished, because by then it
 * is not running. The only instrument that sees the property is one preloaded
 * into the run, holding a baseline from before the first file loaded and
 * checking it after the last one is done.
 *
 * WHY "FIX THE THREE SITES" WAS NOT THE ANSWER. A CORRECT save/restore in a
 * file that loads LATER captures the already-dangling value and faithfully puts
 * it back, so one file doing the right thing preserves another file's
 * corruption and carries it to exit. `test/unit/render.test.ts` does exactly
 * the right thing at `:86` and `:89-90`, and at its position in the run the
 * value it captured was already the dangling one. The leak survived BECAUSE a
 * neighbouring file handled the variable properly.
 *
 * And no argument from file ORDER can rescue it. bun ignores CLI argument
 * order — measured on 1.3.11 in a three-file directory, `a b c` executed as
 * `b, c, a` — because the order is `readdir()` order: not alphabetical, not
 * argument order, and different between APFS and a fresh Linux CI clone. A
 * guard that asserts over the whole PROCESS is immune to all of that, which is
 * why it is shaped this way rather than as a per-file rule.
 *
 * ## How it fails the run
 *
 * Through an `afterAll` registered from a preload, which was chosen after
 * measuring the alternative. On bun 1.3.11 a `process.on("exit")` handler
 * registered in a preload NEVER RUNS under `bun test` — probed directly, the
 * handler produced no output and its `process.exitCode = 42` had no effect on
 * the observed exit code of 0. A preload-registered `afterAll` runs exactly
 * once, after the final file's own `afterAll`, and throwing from it fails the
 * run with exit code 1. That is the only mechanism of the two that works, so
 * it is the one used.
 *
 * ## The idiom this guard is asking for
 *
 * Capture at module load, restore unconditionally in `afterAll`, and restore to
 * ABSENT when it was absent:
 *
 * ```ts
 * const RUNS_DIR_BEFORE = process.env["PIFLEET_RUNS_DIR"];
 * afterAll(() => {
 *   if (RUNS_DIR_BEFORE === undefined) delete process.env["PIFLEET_RUNS_DIR"];
 *   else process.env["PIFLEET_RUNS_DIR"] = RUNS_DIR_BEFORE;
 * });
 * ```
 *
 * An unconditional `delete` is NOT that idiom. It happens to be harmless when
 * the variable was absent, which is the usual case and the reason it survives
 * review, and it silently destroys a value a developer set on the command line
 * when it was not.
 */

import { afterAll } from "bun:test";

/** The namespace the guard watches. Everything pifleet reads is under it. */
export const GUARDED_PREFIX = "PIFLEET_";

/** Where the installed guard records itself, so a test can prove it is live. */
export const GUARD_KEY = "__pifleetEnvHygieneGuard";

/** What the guard parked on `globalThis` at preload time. */
export interface InstalledGuard {
  /** The `PIFLEET_*` variables as they stood before the first test file loaded. */
  readonly baseline: Readonly<Record<string, string>>;
  /** The prefix this installation watches. */
  readonly prefix: string;
}

/** One variable that ended the run in a different state than it started it. */
export interface EnvDrift {
  readonly name: string;
  readonly before: string | undefined;
  readonly after: string | undefined;
  /** `set` — absent then present. `cleared` — present then absent. `changed` — both. */
  readonly kind: "set" | "cleared" | "changed";
}

/** The guarded variables of `env`, by name, ignoring everything else. */
export function snapshotPrefixed(
  env: Record<string, string | undefined>,
  prefix: string = GUARDED_PREFIX,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(env)) {
    if (name.startsWith(prefix) && value !== undefined) out[name] = value;
  }
  return out;
}

/**
 * Every guarded variable whose state differs between the two snapshots.
 *
 * Empty means the run left the environment as it found it. All three kinds are
 * reported rather than only `changed`: a variable that was absent and is now
 * set is how the `tui-command.test.ts` leak actually presented, and a variable
 * the run DELETED is how an unconditional teardown destroys a value the
 * developer supplied.
 */
export function envDrift(
  before: Readonly<Record<string, string>>,
  after: Readonly<Record<string, string>>,
): EnvDrift[] {
  const names = [...new Set([...Object.keys(before), ...Object.keys(after)])].sort();
  const out: EnvDrift[] = [];

  for (const name of names) {
    const b = Object.hasOwn(before, name) ? before[name] : undefined;
    const a = Object.hasOwn(after, name) ? after[name] : undefined;
    if (b === a) continue;
    const kind = b === undefined ? "set" : a === undefined ? "cleared" : "changed";
    out.push({ name, before: b, after: a, kind });
  }

  return out;
}

/** `undefined` rendered as the absence it is, so a report cannot read ambiguously. */
function show(value: string | undefined): string {
  return value === undefined ? "<absent>" : JSON.stringify(value);
}

/**
 * The failure message. Written to be actionable without a debugger: which
 * variable, what it was, what it became, and the idiom that fixes it.
 */
export function formatDrift(drifts: readonly EnvDrift[]): string {
  if (drifts.length === 0) return "";
  const lines = drifts.map(
    (d) => `  ${d.name}: ${d.kind} — before ${show(d.before)}, after ${show(d.after)}`,
  );
  return [
    `${drifts.length} ${GUARDED_PREFIX}* variable(s) differ at process exit from process load:`,
    ...lines,
    "",
    "A test mutated the parent process's environment and did not put it back.",
    "This is not cosmetic: the value survives into every file that loads after",
    "the offender, and a file that correctly saves and restores the variable",
    "will faithfully preserve the corrupted value and carry it to exit.",
    "",
    "Capture at module load and restore unconditionally in afterAll, restoring",
    "to ABSENT when it was absent:",
    "",
    '  const BEFORE = process.env["NAME"];',
    "  afterAll(() => {",
    '    if (BEFORE === undefined) delete process.env["NAME"];',
    '    else process.env["NAME"] = BEFORE;',
    "  });",
    "",
    "Prefer passing `env:` to a spawned subprocess over mutating this process at all.",
  ].join("\n");
}

/** The live installation, or null when the preload did not run in this process. */
export function installedGuard(): InstalledGuard | null {
  const found = (globalThis as Record<string, unknown>)[GUARD_KEY];
  return (found as InstalledGuard | undefined) ?? null;
}

/**
 * Take the baseline and arm the check. Called from the preload and nowhere else.
 *
 * Not called at module scope: `test/unit/env-hygiene-guard.test.ts` imports this
 * module to exercise `envDrift` and `formatDrift`, and an install at import time
 * would register a second `afterAll` inside that file's own scope — a guard that
 * fires in the middle of the run, against a baseline taken in the middle of the
 * run, reporting drift that is merely a test in progress.
 *
 * Idempotent for the same reason: bunfig's `[test] preload` and an explicit
 * `--preload` can both name this file, and a second baseline taken after the
 * first would be the wrong one.
 */
export function installEnvHygieneGuard(
  env: Record<string, string | undefined> = process.env,
  prefix: string = GUARDED_PREFIX,
): InstalledGuard {
  const already = installedGuard();
  if (already !== null) return already;

  const guard: InstalledGuard = { baseline: snapshotPrefixed(env, prefix), prefix };
  (globalThis as Record<string, unknown>)[GUARD_KEY] = guard;

  afterAll(() => {
    const drifts = envDrift(guard.baseline, snapshotPrefixed(env, prefix));
    if (drifts.length > 0) throw new Error(formatDrift(drifts));
  });

  return guard;
}
