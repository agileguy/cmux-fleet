/**
 * Refuse `up` while an MLX training run is active (SRD §5.9; ISC-56).
 *
 * Why this exists: §5.9 records an incident on this machine where concurrent
 * heavy GPU load turned a process OOM into a **kernel watchdog panic**. A fleet
 * of six workers queuing on one Apple-silicon inference server is exactly that
 * load profile, and starting one on top of a training run risks taking the
 * whole host down — which costs the training run too, not just the fleet.
 *
 * ## This is a HEURISTIC, and deliberately labelled as one
 *
 * There is no reliable signal to detect this. Investigated before writing it:
 * `~/mlx-lab` does not exist on this host, no lock-file convention exists
 * anywhere in this codebase or on this machine, and oMLX's API exposes nothing
 * about training — it serves inference and knows nothing about a separate
 * training process. macOS offers no "is the GPU busy training" query either.
 *
 * So this scans the host process list for command lines that LOOK like common
 * MLX training entry points. What that means in practice:
 *
 *  - It CATCHES the standard `mlx_lm` invocations people actually type.
 *  - It does NOT catch a training script with a bespoke name
 *    (`python train_my_model.py`), a run inside a container, a run on another
 *    machine, or anything driven through a notebook kernel whose argv is just
 *    `python -m ipykernel_launcher`.
 *  - It is therefore a guard against the COMMON accident, not a safety
 *    interlock. `--i-know` exists because the operator knows things this scan
 *    cannot see — in BOTH directions.
 *
 * A false negative here is not silent damage; it is the status quo before this
 * guard existed. A false positive costs one `--i-know`. That asymmetry is why a
 * heuristic is worth shipping and why the patterns below stay narrow rather
 * than matching every command line containing "mlx" (which would match the
 * oMLX inference server this fleet REQUIRES to be running).
 */

import { realExec, type Exec } from "../container/run.ts";

export interface MlxProcessMatch {
  pid: number;
  /** The full command line, as `ps` reported it. */
  command: string;
}

/**
 * Command lines that indicate an MLX **training/fine-tuning** run.
 *
 * Each is anchored on an `mlx_lm`/`mlx-lm`/`mlx.` module or subcommand paired
 * with a TRAINING verb. The pairing is the whole design: `mlx_lm.server` is the
 * oMLX inference server, which must be running for a fleet to work at all, so a
 * bare /mlx/ match would refuse every single `up` on a correctly configured
 * host. Every pattern here has to name a training verb — `lora`, `train`,
 * `fuse`, `dpo`, `sft` — and never `server` or `generate`.
 */
export const DEFAULT_MLX_TRAINING_PATTERNS: readonly RegExp[] = [
  /**
   * The dotted module forms, however they are launched:
   *   mlx_lm.lora --train …
   *   python -m mlx_lm.lora …
   *   python3.11 -m mlx_lm.train …
   * `\b` on the left keeps `not_mlx_lm.lora` from matching.
   */
  /\bmlx_lm\.(lora|train|fuse|lora_fuse|dpo|sft)\b/,
  /**
   * The console-script / subcommand forms:
   *   mlx-lm train …
   *   mlx_lm lora …
   * Whitespace-separated rather than dotted, so the pattern above misses them.
   */
  /\bmlx[-_]lm\s+(train|lora|fuse|dpo|sft)\b/,
  /**
   * The `mlx.` namespace form used by some training harnesses:
   *   python -m mlx.lora …
   * Kept separate so the comment above stays true of each pattern in isolation.
   */
  /\bmlx\.(lora|train|fuse)\b/,
];

/**
 * The exact `ps` format this module parses, and the ONLY one
 * `detectActiveMlxTraining` is written against.
 *
 * `pid=,command=` suppresses the header (the trailing `=` per field), so every
 * line is data and there is no header row to skip — a header would otherwise
 * have to be recognised by content, which is how a parser starts guessing.
 *
 * Note what this argv does NOT contain: the string "mlx". A scan whose own
 * command line matches its own patterns finds itself, reports a training run
 * that is really just the guard, and refuses every `up` forever. Keeping the
 * needle out of the haystack is cheaper and more durable than filtering the
 * result afterwards.
 */
export const PS_ARGV: readonly string[] = ["ps", "-axo", "pid=,command="];

/**
 * Parse `ps -axo pid=,command=` output and return the training-shaped matches.
 *
 * Pure: no spawning, no clock, no environment beyond `process.pid`. Every
 * interesting case is therefore reachable from a canned string in a unit test,
 * which is the point — the alternative is a guard whose behaviour can only be
 * observed by starting a real training run.
 *
 * The current process is excluded. `pifleet up` is itself in the process list,
 * and a future argv (or a test harness) that happens to carry a matching string
 * would otherwise make the guard refuse on account of itself.
 */
export function detectActiveMlxTraining(
  psOutput: string,
  patterns: readonly RegExp[] = DEFAULT_MLX_TRAINING_PATTERNS,
): MlxProcessMatch[] {
  const matches: MlxProcessMatch[] = [];
  for (const raw of psOutput.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    // `ps` right-aligns the pid in a padded column, hence the trim above; the
    // command is everything after the first run of whitespace, and is NOT
    // trimmed further because argv can legitimately contain runs of spaces.
    const split = line.match(/^(\d+)\s+(.*)$/);
    if (split === null) continue;
    const pid = Number(split[1]);
    const command = split[2] ?? "";
    if (!Number.isSafeInteger(pid) || pid === process.pid) continue;
    if (patterns.some((p) => p.test(command))) matches.push({ pid, command });
  }
  return matches;
}

/** Read the host process list in the exact format `detectActiveMlxTraining` parses. */
export async function listHostProcesses(exec: Exec = realExec): Promise<string> {
  const r = await exec([...PS_ARGV], { timeoutMs: 10_000 });
  return r.stdout;
}

/**
 * Scan the host for active MLX training runs.
 *
 * Returns matches rather than throwing, because the CALLER owns the policy: it
 * is `up` that knows whether `--i-know` was passed, and a guard that refused on
 * its own could not be overridden. A `ps` that fails returns no output and
 * therefore no matches — the guard fails OPEN, deliberately: refusing to start
 * a fleet because a process listing was unavailable would convert a
 * best-effort convenience into an outage of its own.
 */
export async function checkMlxTrainingGuard(exec: Exec = realExec): Promise<MlxProcessMatch[]> {
  return detectActiveMlxTraining(await listHostProcesses(exec));
}

/** One match, rendered for an operator: pid plus a bounded command line. */
export function describeMatch(m: MlxProcessMatch): string {
  const cmd = m.command.length > 120 ? `${m.command.slice(0, 117)}...` : m.command;
  return `pid ${m.pid}: ${cmd}`;
}
