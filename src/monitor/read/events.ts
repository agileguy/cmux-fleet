/**
 * A BOUNDED tail of one worker's `events.jsonl` (SRD-FLEET-MONITOR §2.4, D6).
 *
 * ## The number this file exists for
 *
 * §2.4 measured the worst case on this host: **24.7 MB across 8,336 lines** in
 * a single `events.jsonl`, and the log is asymmetric — an `rpc` worker writes
 * ~3 KB per line for the life of the run, a `tui` worker writes a few
 * kilobytes total. So the expensive case is not exotic; it is the ordinary
 * case for the workers an operator most wants to watch. A reader that parses
 * whole files does not merely get slow, it gets slow only on the fleet that
 * matters.
 *
 * This module therefore reads a fixed byte window ending at EOF and nothing
 * else. `bytesRead` is reported rather than inferred so the bound is a fact a
 * test can assert instead of a claim a docblock makes.
 *
 * ## Why NOT `TailReader`, which is the obvious answer
 *
 * `util/jsonl.ts`'s `TailReader` is the repo's tailer and `logs.ts:36` is its
 * precedent, so declining it needs a reason rather than a preference. The
 * reason is its FIRST poll: `TailReader` starts at offset 0 and "reads
 * everything appended since the last poll", which on a reader that has never
 * polled is the entire file — handed to a single `LineSplitter.push`
 * (`util/jsonl.ts:101-102` records exactly that, as the reason the line cap
 * had to move). Pointed at the measured 24.7 MB log, the first tick of a
 * monitor using `TailReader` performs precisely the read this design forbids,
 * and it would look correct in review because every subsequent tick is a
 * delta.
 *
 * `TailReader` is the right tool for FOLLOWING a file from a known offset,
 * which is what `logs.ts` does and what a monitor could adopt on the medium
 * clock once it holds an offset. It is the wrong tool for the first frame, and
 * the first frame is what §6.3 has to paint inside the fast clock's period.
 *
 * ## What is deliberately NOT done here
 *
 * No rendering. `logs.ts:66-100`'s `renderEventLine` already solved the
 * legibility half — `RENDER_CLIP`, the C0/C1 class, and a `sanitize` that
 * REPLACES rather than strips so "a visible U+FFFD tells the operator content
 * was withheld" — and this module returns raw lines so the display layer can
 * reuse that function rather than have a second one grow here. Not importing
 * it is a posture decision, not an oversight: `logs.ts` lives under
 * `src/cli/commands/`, and D3's read-only walk is cheapest to state when the
 * monitor's import list touches that directory nowhere at all.
 *
 * No JSON parsing either. A tail window begins mid-file, so a caller that
 * needs objects should parse with `util/jsonl.ts`'s `parseLine`, whose
 * `undefined`-on-failure contract is already the tolerant one this stream
 * needs.
 */

import { stat } from "node:fs/promises";
import { failed, ok, type Region } from "../model.ts";
import { LineSplitter } from "../../util/jsonl.ts";
import type { WorkerPaths } from "../../run/paths.ts";

/**
 * The default window: 64 KiB ending at EOF.
 *
 * Sized against §2.4's measurement rather than picked: at ~3 KB per line for
 * an `rpc` worker this is roughly the last twenty events, and at a few hundred
 * bytes per line for a `tui` worker it is most of the run. Twenty events is
 * more than §1.3's questions need and far less than a tick can afford — the
 * whole file is 385x this on the measured worst case.
 */
export const EVENT_TAIL_BYTES = 64 * 1024;

/**
 * The hard ceiling on any caller's window.
 *
 * The bound is the PROPERTY this module provides, and a bound a caller can
 * raise is not a bound — a future `readEventTail(paths, { windowBytes:
 * file.size })` would satisfy every type in this file while performing the
 * 24.7 MB read the module exists to prevent. Clamping rather than throwing
 * because a too-large request is a caller bug, not an operator-facing failure,
 * and a monitor that refuses to paint is worse than one that paints a smaller
 * window (§4.3).
 */
export const EVENT_TAIL_MAX_BYTES = 1024 * 1024;

export interface EventTail {
  /**
   * Complete lines inside the window, oldest first.
   *
   * The FIRST line of the window is dropped whenever {@link clippedHead} is
   * true: a window that starts mid-file almost always starts mid-record, and
   * the fragment that results is a suffix of a JSON object. Handing it to a
   * caller would present half a record as a whole one — the same corruption
   * `util/jsonl.ts:57-67`'s resync guard exists to prevent one layer down,
   * where the comment records it being "handed to the caller as if it were
   * valid".
   *
   * The last line is dropped when the file does not end in a newline, because
   * on an append-only log a trailing partial line is an incomplete write and
   * not a record (`util/jsonl.ts:132-135`).
   */
  readonly lines: readonly string[];
  /**
   * Bytes actually read from disk. **This is the assertable half of the
   * criterion** — a docblock claiming a bounded read is not evidence, and this
   * number is.
   */
  readonly bytesRead: number;
  /** The file's size at the moment of the read, from one `stat`. */
  readonly fileBytes: number;
  /** The window in force, after clamping to {@link EVENT_TAIL_MAX_BYTES}. */
  readonly windowBytes: number;
  /** True when the window did not reach byte 0 — i.e. earlier events exist. */
  readonly clippedHead: boolean;
  /**
   * False when the log does not exist yet, which is NORMAL and not a failure:
   * the supervisor creates `events.jsonl` lazily, which is why `logs.ts`'s
   * `--follow` waits for a file that is not there (`logs.ts:26-29`).
   */
  readonly present: boolean;
}

/**
 * Read the tail of `paths.eventsJsonl`.
 *
 * ## Why absence is `ok` here and `never` in `worker.ts`
 *
 * `model.ts:57-64` insists that "I could not look" and "I looked and there was
 * nothing" stay apart. A missing `events.jsonl` is the SECOND: an empty tail
 * is a truthful, fully-formed value of this type, so it is `ok` with an empty
 * `lines` and `present: false`. `worker.ts` reaches the opposite answer for a
 * missing `state.json` because `WorkerRow` has no empty inhabitant — see the
 * argument there. The line between the two is whether the value type can
 * represent "nothing", not whether the file was there.
 *
 * `readAt` is stamped after the read completes, per `model.ts:44`.
 */
export async function readEventTail(
  paths: WorkerPaths,
  opts?: { readonly windowBytes?: number; readonly now?: () => number },
): Promise<Region<EventTail>> {
  const now = opts?.now ?? Date.now;
  const windowBytes = Math.max(
    0,
    Math.min(opts?.windowBytes ?? EVENT_TAIL_BYTES, EVENT_TAIL_MAX_BYTES),
  );
  const path = paths.eventsJsonl;

  let fileBytes: number;
  try {
    fileBytes = (await stat(path)).size;
  } catch {
    /**
     * ENOENT is the overwhelmingly common case and it is not a failure. Every
     * other `stat` error — EACCES on a run directory owned by another user,
     * ELOOP on a replaced path — is folded in with it deliberately: none of
     * them is distinguishable here without a second syscall, and all of them
     * mean the same thing to this reader, which is that there is no tail to
     * show. A worker whose log is unreadable for a permissions reason still
     * has a state file, and `worker.ts` is where that row goes wrong loudly.
     */
    return ok(emptyTail(windowBytes), now());
  }

  const start = Math.max(0, fileBytes - windowBytes);
  const clippedHead = start > 0;

  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await Bun.file(path).slice(start, fileBytes).arrayBuffer());
  } catch (err) {
    return failed(`unreadable event log ${path}: ${firstLine(err)}`, now());
  }

  /**
   * Fed as BYTES rather than text so `LineSplitter`'s streaming `TextDecoder`
   * owns the boundary problem: a window that starts mid-codepoint decodes its
   * leading bytes to U+FFFD rather than throwing, and those replacement
   * characters land in the first line — which `clippedHead` then drops anyway.
   */
  const splitter = new LineSplitter();
  let lines: string[];
  try {
    lines = splitter.push(bytes);
  } catch (err) {
    /**
     * `LineTooLongError` is unreachable at any window this module permits —
     * the cap is 8 MiB of code units (`util/jsonl.ts:26`) and the largest
     * window is 1 MiB of bytes — but it is CAUGHT rather than assumed away.
     * The assumption is a relationship between two constants in two files, and
     * this module's entire subject is a file that grew 385x past what anyone
     * expected of it.
     */
    return failed(`unreadable event log ${path}: ${firstLine(err)}`, now());
  }

  // `flush()` is deliberately not called: see EventTail.lines.
  if (clippedHead && lines.length > 0) lines = lines.slice(1);

  return ok(
    {
      lines,
      bytesRead: bytes.length,
      fileBytes,
      windowBytes,
      clippedHead,
      present: true,
    },
    now(),
  );
}

function emptyTail(windowBytes: number): EventTail {
  return {
    lines: [],
    bytesRead: 0,
    fileBytes: 0,
    windowBytes,
    clippedHead: false,
    present: false,
  };
}

/** One line of diagnosis, on `StateReadError`'s reasoning (`run/state.ts:794-796`). */
function firstLine(err: unknown): string {
  if (err instanceof Error) return err.message.split("\n")[0] ?? err.message;
  return String(err);
}
