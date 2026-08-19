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
 * So this scans the host process list for processes whose EXECUTABLE looks like
 * a common MLX training entry point. What that means in practice:
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
 * guard existed. A false positive REFUSES EVERY `up` until the operator finds
 * the flag. That asymmetry is why the matcher answers two questions rather than
 * one — is this token a training entry point, AND is this token the program
 * being run — instead of grepping the command line for a name. Matching a name
 * anywhere in the line is the obvious first implementation, it was what shipped
 * to review, and it refused `up` on a host merely SERVING a LoRA adapter. See
 * `DEFAULT_MLX_TRAINING_PATTERNS` for the full argument.
 */

import { realExec, type Exec } from "../container/run.ts";

export interface MlxProcessMatch {
  pid: number;
  /** The full command line, as `ps` reported it. */
  command: string;
}

/**
 * The training/fine-tuning verbs. Never `server` and never `generate`: those
 * are the INFERENCE entry points, and `mlx_lm.server` is the oMLX server this
 * whole fleet requires to be running.
 */
const TRAINING_VERBS = "lora|train|fuse|lora_fuse|dpo|sft|grpo|orpo|finetune";

/**
 * Patterns that identify a training entry point — tested against ONE PROGRAM
 * TOKEN at a time, never against a whole command line.
 *
 * ## Why the verb pairing is necessary but NOT sufficient
 *
 * An earlier version of this module substring-matched the entire `ps` command
 * line and claimed in this comment that naming a training verb was the whole
 * design — that `mlx_lm.server` could never be caught because it carries no
 * verb. That claim was false, and the counterexample is not exotic:
 *
 *     python -m mlx_lm.server --port 8000 --adapter-path /Users/dan/out/mlx_lm.lora
 *
 * Serving a LoRA adapter whose output directory is named after the entry point
 * that produced it is the ordinary way to serve a fine-tune. The old patterns
 * matched the ADAPTER PATH, so this refused every `up` on a host running the
 * inference server the fleet requires — precisely the catastrophic outcome the
 * design was written to avoid. Two more of the same shape, both verified:
 *
 *     tail -f /Users/dan/logs/mlx_lm.lora.log
 *     grep -rn mlx_lm.lora /Users/dan/repos
 *
 * A verb tells you WHAT a token names. It cannot tell you whether the token is
 * a program at all, and a filename is not a running process. So the guard now
 * decides POSITION first (`programTokens`, below) and only then applies these:
 * a candidate must be the thing being executed, and must end there — the `$`
 * anchor is what keeps `mlx_lm.lora.log` out.
 *
 * `(?:^|/)` rather than `\b` on the left, because a path segment boundary is
 * the real boundary: it admits `/tmp/x/mlx_lm.lora` and still rejects
 * `not_mlx_lm.lora`, where `\b` would have to admit both or neither.
 *
 * Case-insensitive. An uppercase invocation is not a normal way to type any of
 * these, but the whole point of a guard is the argv nobody predicted, and
 * nothing legitimate is swept in by allowing it.
 */
export const DEFAULT_MLX_TRAINING_PATTERNS: readonly RegExp[] = [
  /**
   * The dotted module form, as a bare token or as the tail of a path:
   *   mlx_lm.lora --train …
   *   python -m mlx_lm.lora …
   *   /bin/sh /tmp/x/mlx_lm.lora --train …
   * `vlm` is included because oMLX enables VLM tool parsers on this very host,
   * so `mlx_vlm` fine-tuning is a workload this machine plausibly runs.
   */
  new RegExp(`(?:^|/)mlx[-_](?:lm|vlm)\\.(?:${TRAINING_VERBS})$`, "i"),
  /**
   * The `mlx.` namespace form used by some training harnesses:
   *   python -m mlx.lora …
   */
  new RegExp(`(?:^|/)mlx\\.(?:lora|train|fuse)$`, "i"),
  /**
   * The SCRIPT form — the standard venv / `uv run` invocation, which runs the
   * module's file rather than the module:
   *   python …/site-packages/mlx_lm/lora.py --train
   * Slash, not dot, so the first pattern misses it entirely. The directory is
   * load-bearing here: `lora.py` alone names half the fine-tuning scripts on
   * GitHub and would be far too broad on its own.
   */
  new RegExp(`(?:^|/)mlx[-_](?:lm|vlm)/(?:${TRAINING_VERBS})\\.py$`, "i"),
];

/**
 * Programs that RUN other programs, by basename.
 *
 * This is the gate that makes position analysis possible. Past argv[0], a token
 * only names a program if argv[0] is something that executes one — so
 * `grep mlx_lm.lora .` is inert (grep runs nothing) while
 * `/bin/sh …/mlx_lm.lora --train` is a real training run.
 *
 * `sh` is not padding: macOS resolves a `#!/bin/sh` script by execing
 * `/bin/sh <script> <args…>`, so EVERY shebang-launched training script — and
 * every decoy the integration suites spawn — arrives with `sh` in argv[0] and
 * its real identity in argv[1]. Measured, not assumed:
 *   `/bin/sh /var/folders/…/mlx_lm.lora --model Qwen3-8B --train --data ./corpus`
 * A rule that looked only at argv[0] and `-m` would see `sh`, match nothing,
 * and turn the guard off for the most common launch shape there is.
 */
const PROGRAM_RUNNERS: ReadonlySet<string> = new Set([
  "sh", "bash", "zsh", "dash", "ksh", "env",
  "python", "python2", "python3", "pythonw",
  "uv", "uvx", "pipenv", "poetry", "pdm", "hatch", "conda", "mamba",
  "nohup", "time", "caffeinate", "stdbuf", "nice",
  "accelerate", "torchrun", "deepspeed",
  "mlx_lm", "mlx-lm", "mlx_vlm", "mlx-vlm",
]);

/** `python3.11`, `python3.13` — versioned interpreters, by shape not by list. */
const VERSIONED_PYTHON = /^python\d+(?:\.\d+)*$/;

function basenameOf(token: string): string {
  const cut = token.lastIndexOf("/");
  return cut < 0 ? token : token.slice(cut + 1);
}

function isProgramRunner(token: string): boolean {
  const base = basenameOf(token);
  return PROGRAM_RUNNERS.has(base) || VERSIONED_PYTHON.test(base);
}

/**
 * The tokens in a command line that could NAME A PROGRAM.
 *
 * Exported because it is the half of this guard that the patterns cannot
 * express, and a rule that is not directly testable is a rule that drifts.
 *
 * The rules, in order:
 *
 *  1. argv[0] always qualifies — it is the executable by definition.
 *  2. Nothing else qualifies unless argv[0] is a runner (see above). This is
 *     what makes `grep -rn mlx_lm.lora …` and `tail -f …mlx_lm.lora.log` inert:
 *     grep and tail execute nothing, so their arguments are data.
 *  3. The token after `-m` always qualifies — that is `python -m <module>`, and
 *     it can sit arbitrarily far right (`python -u -X dev -m mlx_lm.lora`).
 *  4. Any other token qualifies only if it is neither a flag nor a FLAG'S
 *     VALUE. `--adapter-path /Users/dan/out/mlx_lm.lora` is the case this
 *     exists for: the path is an argument to a flag, so it names a directory,
 *     never a process.
 *  5. A bare `mlx_lm`/`mlx-lm` console script in argv[0] gets its subcommand
 *     folded back into dotted form (`mlx-lm train` → `mlx-lm.train`), so the
 *     dotted pattern covers both spellings instead of a second pattern that
 *     has to re-state the verb list.
 *
 * Rule 4 is a heuristic about POSIX argv conventions, not a parse: a program
 * with a `--flag value` option this code cannot know about is indistinguishable
 * from one with a positional. It errs toward NOT matching, which is the correct
 * direction for a guard whose false positive refuses every `up` (see the
 * asymmetry argument in the module header).
 */
export function programTokens(command: string): string[] {
  const tokens = command.trim().split(/\s+/).filter((t) => t.length > 0);
  if (tokens.length === 0) return [];
  const out: string[] = [tokens[0]!];

  if (basenameOf(tokens[0]!).replace(/\.(exe)$/i, "").match(/^mlx[-_](?:lm|vlm)$/i) !== null) {
    const sub = tokens[1];
    if (sub !== undefined && !sub.startsWith("-")) out.push(`${basenameOf(tokens[0]!)}.${sub}`);
  }

  if (!isProgramRunner(tokens[0]!)) return out;

  for (let i = 1; i < tokens.length; i++) {
    const tok = tokens[i]!;
    const prev = tokens[i - 1]!;
    if (prev === "-m") {
      out.push(tok);
      continue;
    }
    if (prev.startsWith("-")) continue; // a flag's value never names a process
    if (tok.startsWith("-")) continue; // a flag is not a program
    out.push(tok);
  }
  return out;
}

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
 * `patterns` are matched against the PROGRAM TOKENS of each command line (see
 * `programTokens`), never against the raw line. That is the fix for the class
 * of false positive documented on `DEFAULT_MLX_TRAINING_PATTERNS`: a training
 * entry point's name appearing as a flag's value, a log path or a grep argument
 * is a string, not a running process, and only position can tell them apart.
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
    const candidates = programTokens(command);
    if (candidates.some((c) => patterns.some((p) => p.test(c)))) matches.push({ pid, command });
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
