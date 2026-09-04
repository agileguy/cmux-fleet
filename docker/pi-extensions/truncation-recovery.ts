/**
 * Truncated bash output, made recoverable.
 *
 * ## The failure this exists for, measured
 *
 * 2026-09-04, worker `tick-1` (`gpt-oss-20b` via oMLX), task
 * `T-accepted-tickets`. It ran the correct command on the first try:
 *
 *     rally-cli tickets --current-iteration --my-tickets --state Accepted --format json
 *
 * The answer was in that output — nineteen tickets. The worker never gave it.
 * It ran the same command, read `rally-cli --help`, ran the SAME COMMAND AGAIN,
 * and quiesced without writing a result envelope. Harvest graded it `unknown`:
 * *"the worker's own account of what it did is absent"*. The operator recovered
 * the answer by hand, from inside the container.
 *
 * The output was 56,268 bytes. Pi's bash tool keeps the last
 * `DEFAULT_MAX_BYTES` (50KB) via `truncateTail` and writes the whole thing to
 * `/tmp/pi-bash-<id>.log`. So 89% of the bytes reached the model. **All of the
 * meaning did not**, and the three reasons are the whole design of this file:
 *
 * **1. Tail-truncating a JSON document destroys it completely.** `truncateTail`
 * is the right choice for a log — errors are at the end. It is the worst
 * possible choice for structured output, because the one byte that cannot be
 * spared is the opening `{`, and it is the first to go. What arrives is a wall
 * of syntactically plausible JSON that `JSON.parse` and `jq` both refuse. Losing
 * 11% of the bytes cost 100% of the parseability. Nothing in the result said so.
 *
 * **2. The notice was in the last place a reader looks.** Pi appends
 * `[... truncated (50.0KB limit). Full output: <path>]` at the END — after
 * 50KB. A model forms its answer while reading; by the time the footer arrives
 * it has already decided the output was unusable. Moving the same facts to the
 * TOP is most of this fix.
 *
 * **3. A path is a fact, not an instruction.** `Full output: /tmp/pi-bash-x.log`
 * tells a strong model everything and a 20B model nothing. `tick-1` never
 * opened that file. It re-ran the command instead — which is the one action
 * guaranteed to reproduce the truncation byte for byte, and it did it twice.
 *
 * ## What this does
 *
 * Hooks `tool_result`, and when a bash result carries `details.truncation`
 * with `truncated: true`, PREPENDS a banner and returns it as replacement
 * `content`. The truncated bytes are kept underneath, unchanged — for a log
 * they are still the most useful part, and this file is not in the business of
 * deciding which commands produce logs.
 *
 * The banner names the size, the path, whether the surviving bytes are a
 * structural fragment, and one command that would get the answer. When the
 * COMPLETE output on disk parses as JSON, it says so and describes the shape,
 * because that is the case where the visible bytes are actively misleading and
 * where a one-line `jq` finishes the job.
 *
 * ## Why an extension and not a bigger limit
 *
 * `DEFAULT_MAX_BYTES` is a module constant in Pi's `dist/`, not a setting —
 * `bash-executor.js` calls `truncateTail(fullOutput)` with no options, so there
 * is no per-call override and no config key. Raising it means patching vendored
 * JS in the Dockerfile, which is brittle in the direction that matters: a
 * silently-failing patch after a `PI_VERSION` bump restores the exact bug this
 * fixes. And it would not work anyway. A worker on a 20B model does not fail at
 * 50KB because 50KB is too small; it fails because 50KB of clipped JSON is
 * unusable at ANY size. 200KB moves the cliff and makes context exhaustion the
 * new failure. The fix has to make truncation SURVIVABLE, not rarer.
 *
 * ## Why it is unconditional, unlike the auto-trigger
 *
 * `render.ts` gates `--extension <DISPATCH_TRIGGER_PATH>` on
 * `paneMode === "tui" && autoTrigger`, because a staged brief is a `tui`-only
 * concept. Nothing here is mode-specific: an rpc worker truncates identically,
 * and its operator is a program that will not notice. This one loads for every
 * worker in both modes.
 */

import { readFileSync } from "node:fs";

/**
 * Pi's `TruncationResult`, declared STRUCTURALLY rather than imported, for the
 * reason `dispatch-trigger.ts` gives at length: the package lives in the worker
 * image and not in this repo, so a real import would make this file
 * uncheckable here and untestable anywhere. A subset cannot drift into claiming
 * Pi has a field it does not — only into failing to mention one this file never
 * reads. `test/unit/truncation-recovery.test.ts` pins the field names against
 * the real `.d.ts` when the image is present.
 */
export interface Truncation {
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  maxBytes: number;
  maxLines: number;
  /** Tail truncation may cut mid-line; head truncation never does. */
  lastLinePartial: boolean;
}

/** The slice of `BashToolDetails` this file reads. */
export interface BashDetails {
  truncation?: Truncation;
  fullOutputPath?: string;
}

/** The slice of `ToolResultEvent` this file reads. */
export interface ToolResultEventLike {
  type: "tool_result";
  toolName: string;
  content: { type: string; text?: string }[];
  details?: unknown;
}

/** The slice of `ToolResultEventResult` this file returns. */
export interface ToolResultReplacement {
  content: { type: "text"; text: string }[];
}

/** The slice of `ExtensionAPI` this file uses. */
interface ExtensionAPI {
  on(
    event: "tool_result",
    handler: (event: ToolResultEventLike) => ToolResultReplacement | undefined,
  ): void;
}

/**
 * Mirrors Pi's own `formatSize`, so the banner and the footer Pi already
 * appended agree about how big the output was. Two different roundings of the
 * same number in one tool result reads as two different numbers.
 */
export function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * How many bytes of the complete output to read back for shape detection.
 *
 * The point of reading the file is to answer "is this parseable JSON, and what
 * shape", which needs all of it — a prefix cannot be parsed either. The cap is
 * a refusal, not a sample: past it, this file says nothing about shape rather
 * than guessing from a fragment, which is exactly the mistake it exists to
 * stop the WORKER making. 8MB covers every real command output and bounds the
 * read against a worker that cats a disk image.
 */
export const MAX_SHAPE_PROBE_BYTES = 8 * 1024 * 1024;

/**
 * What the complete output turned out to be, and how to cut it down.
 *
 * `filter` and `hint` are carried alongside `text` rather than derived from it
 * by the caller, because they are decided from the PARSED value — how many
 * elements, which key holds the rows — and that information is gone by the
 * time the sentence has been written.
 */
export interface Shape {
  /** The banner's `shape` line. */
  text: string;
  /** A `jq` filter that fits this payload. */
  filter: string;
  /** What that filter returns, for the trailing comment. */
  hint: string;
}

/**
 * Describe the complete output's structure, or null if there is nothing useful
 * to say.
 *
 * Deliberately narrow. It answers one question — *"are the visible bytes a
 * fragment of a document that would parse if you read the whole file?"* —
 * because that is the case where the model's natural next move (parse what it
 * can see) is guaranteed to fail and its correct next move (read the file) is
 * not obvious. For anything that is not JSON, silence: a log truncated from
 * the front is still a log, and inventing advice about it would bury the case
 * that matters.
 */
export function describeShape(full: string): Shape | null {
  const trimmed = full.trim();
  if (trimmed === "") return null;
  if (!trimmed.startsWith("{") && !trimmed.startsWith("[")) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    // The complete output is not valid JSON either. Saying "not JSON" here
    // would be a claim about the command, not about the truncation, and this
    // file has no standing to make it.
    return null;
  }
  if (Array.isArray(parsed)) {
    return {
      text: `valid JSON — an array of ${parsed.length} element${parsed.length === 1 ? "" : "s"}`,
      filter: ".[0]",
      hint: "one element, to see the field names before projecting",
    };
  }
  /*
   * Necessarily an object by here: the guard above admits only text starting
   * with `{` or `[`, and nothing else parses to a scalar or to null. There is
   * deliberately no scalar branch — it would be unreachable, and unreachable
   * code in a file whose whole job is honesty about what was and was not seen
   * is the wrong thing to leave for the next reader.
   */
  const obj = parsed as Record<string, unknown>;
  const keys = Object.keys(obj);
  const shown = keys.slice(0, 8).map((k) => JSON.stringify(k)).join(", ");
  const more = keys.length > 8 ? `, +${keys.length - 8} more` : "";
  const text = `valid JSON — an object with keys ${shown}${more}`;

  /*
   * The narrowing filter, chosen from the data rather than from a guess.
   *
   * MEASURED 2026-09-04, and this is why the field exists. The first version of
   * this file suggested a fixed `jq '.data[].name'`, lifted from the rally-cli
   * case that prompted the work. On the live probe — an object with keys `ok`,
   * `rows`, `done` — the worker read that example, improvised `jq -n 'keys'`
   * (wrong: `-n` reads no input), got "not valid JSON", and needed a second
   * call to recover. A hard-coded example is a wrong answer for every payload
   * but one, and a wrong example is worse than none: it is confident.
   *
   * A single array-valued key is the shape that actually recurs — a wrapper
   * object around the rows, which is what `rally-cli`, `kubectl -o json` and
   * `gcloud --format=json` all return. When there is exactly one, it is the
   * rows and naming it is unambiguous. When there are none or several, the
   * honest suggestion is `keys`, which commits to nothing.
   */
  const arrayKeys = keys.filter((k) => Array.isArray(obj[k]));
  if (arrayKeys.length === 1) {
    const k = arrayKeys[0]!;
    const n = (obj[k] as unknown[]).length;
    return { text, filter: `.${k}[0]`, hint: `the first of ${n} in "${k}"` };
  }
  return { text, filter: "keys", hint: "the top level, one key at a time" };
}

/**
 * The one command most likely to finish the job, or null.
 *
 * A single concrete line beats a paragraph of options: the measured failure was
 * a model that had the path and did not act on it, and the repair for that is
 * something it can copy. `jq` is in every toolchain's base layer, so the JSON
 * suggestion is always runnable.
 */
export function recoveryCommand(path: string | undefined, shape: Shape | null): string | null {
  if (path === undefined) return null;
  if (shape !== null) return `jq '${shape.filter}' ${path}   # ${shape.hint}`;
  return `tail -n 200 ${path}   # or grep it — the complete output is on disk`;
}

/**
 * The banner, or null when this result needs no banner.
 *
 * Null rather than an empty string so the caller's "did anything change?" test
 * is an identity check and cannot be satisfied by a whitespace-only rewrite.
 */
export function recoveryBanner(
  details: BashDetails | undefined,
  readFull: (path: string) => string | null,
): string | null {
  const t = details?.truncation;
  if (t === undefined || !t.truncated) return null;

  const path = details?.fullOutputPath;
  const full = path === undefined ? null : readFull(path);
  const shape = full === null ? null : describeShape(full);

  /*
   * "clipped from the FRONT" is the sentence the measured failure needed and
   * did not get. Pi's own footer says a limit was hit; it never says which END
   * went missing, and for tail truncation — the bash default — the missing end
   * is the one that carries a document's opening delimiter.
   */
  const lines: string[] = [
    "⚠️  OUTPUT TRUNCATED — the text below is NOT the whole output.",
    "",
    `    kept       ${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}` +
      ` (${t.outputLines} of ${t.totalLines} lines), clipped from the FRONT` +
      ` — the limit hit was ${t.truncatedBy === "lines" ? `${t.maxLines} lines` : formatSize(t.maxBytes)}`,
  ];

  if (path !== undefined) {
    lines.push(`    complete   ${path}  ← every byte, nothing removed`);
  }
  if (shape !== null) {
    lines.push(`    shape      ${shape.text}`);
  }
  lines.push("");

  if (shape !== null) {
    lines.push(
      "The COMPLETE output parses. The bytes below DO NOT — they begin mid-document,",
      "because tail truncation drops the opening delimiter first. Do not try to parse",
      "what you can see here; read the complete file instead.",
    );
  } else if (path !== undefined) {
    lines.push("The beginning of the output is missing from the text below. It is on disk in full.");
  }

  const cmd = recoveryCommand(path, shape);
  if (cmd !== null) {
    lines.push("", `    ${cmd}`);
  }

  /*
   * The last line addresses the actual observed loop. `tick-1` ran its command,
   * hit the cap, consulted `--help`, and ran the identical command again — the
   * one action that cannot produce a different result. Naming it is cheap and
   * it is the specific mistake that was made.
   */
  lines.push(
    "",
    "Re-running the same command will truncate identically. Read the file above,",
    "or narrow the command (a filter, a field selector, a smaller range) — not both blind.",
  );

  return lines.join("\n");
}

/**
 * Read a complete-output file, or null on any failure.
 *
 * Every failure is null because the caller's response to all of them is the
 * same: emit the banner without a shape line. A missing or unreadable log is
 * not worth a diagnostic of its own — the worker's problem is the truncation,
 * and a banner that names the size and the path is still most of the fix.
 */
export function readFullOutput(path: string): string | null {
  try {
    const buf = readFileSync(path);
    if (buf.byteLength > MAX_SHAPE_PROBE_BYTES) return null;
    return buf.toString("utf8");
  } catch {
    return null;
  }
}

/**
 * Prepend the banner to a truncated bash result, or return undefined to leave
 * the result exactly as Pi produced it.
 *
 * `undefined` is Pi's "no opinion" for a `tool_result` handler, and it is what
 * every non-bash tool and every untruncated result gets. Returning a
 * byte-identical replacement instead would work but would make the handler
 * look like it acts on everything, which is the sort of thing a later reader
 * optimises away without realising it was already a no-op.
 */
export function rewriteBashResult(
  event: ToolResultEventLike,
  readFull: (path: string) => string | null = readFullOutput,
): ToolResultReplacement | undefined {
  if (event.toolName !== "bash") return undefined;
  const banner = recoveryBanner(event.details as BashDetails | undefined, readFull);
  if (banner === null) return undefined;

  /*
   * Only the FIRST text block is prefixed, and image blocks are passed through
   * untouched. A bash result is one text block in practice; prefixing every
   * block would repeat the banner, and dropping the non-text blocks to
   * simplify would silently discard content this file does not understand.
   */
  let done = false;
  const content = event.content.map((c) => {
    if (done || c.type !== "text") return c as { type: "text"; text: string };
    done = true;
    return { type: "text" as const, text: `${banner}\n\n${c.text ?? ""}` };
  });
  if (!done) content.unshift({ type: "text" as const, text: banner });
  return { content: content as { type: "text"; text: string }[] };
}

export default function (pi: ExtensionAPI): void {
  pi.on("tool_result", (event) => rewriteBashResult(event));
}
