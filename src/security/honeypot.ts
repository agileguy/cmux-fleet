/**
 * Reading the escape-attempt honeypot's records back out (ISC-125).
 *
 * `docker/honeypot.cjs` writes into the worker's verbgate ledger, and
 * `run/verbgate-collect.ts` takes host-side custody of that file on every
 * daemon tick — wrapping each worker-authored line, verbatim, in a `line`
 * string field. This module turns that collected copy into the one sentence
 * an operator needs: was this container watched, and did anything try.
 *
 * ## Why this is pure, and takes records rather than a path
 *
 * The interesting cases are all about MALFORMED or MISSING input — a worker
 * that fills its ledger with junk, a truncated collection, a container that
 * never armed — and every one of them has to be reachable from a unit test
 * without a Docker daemon. Reading is the caller's job; deciding what the
 * bytes mean is this module's.
 *
 * ## Trust boundary, stated because it is easy to get backwards
 *
 * The `line` bytes are WORKER-AUTHORED. A hostile worker can append anything
 * it likes to its own ledger, including a well-formed `honeypot_armed` or a
 * thousand fake `escape_attempt` rows. That is deliberately not defended
 * against here, and the reason is that neither forgery helps an attacker:
 *
 *  - Forging attempts raises an alarm against yourself.
 *  - Forging `armed` claims you were watched — which is only useful if you
 *    ALSO suppressed the real detector, and the detector's death ends the
 *    container (`docker/entrypoint.sh`), while erasing already-collected rows
 *    is what ISC-172's truncation mark makes visible.
 *
 * What a worker cannot do is make a REAL attempt disappear from the host's
 * copy once a tick has collected it. That asymmetry — forgery is useless,
 * erasure is marked — is the guarantee, and it is weaker than "the rows are
 * authentic". Do not restate it as the stronger sentence.
 */

import { EscapeWatchSchema, type EscapeWatch } from "../contracts.ts";
import type { CollectedVerbgateRecord } from "../run/verbgate-collect.ts";

/** The `event` values `docker/honeypot.cjs` emits. Nothing else is honeypot. */
const ARMED = "honeypot_armed";
const ATTEMPT = "escape_attempt";
const FLOOD = "escape_attempt_flood";

/**
 * One honeypot row, as far as we are willing to believe a worker-authored
 * line. Only the fields this module reads are named; anything else on the
 * line is ignored rather than rejected, because the verbgate rows sharing
 * this file are a different shape entirely and are not errors.
 */
interface HoneypotLine {
  event: string;
  ts?: unknown;
}

/**
 * Parse one collected line, or `null`.
 *
 * `null` covers three cases that must not be distinguished here: a verbgate
 * decision row (the overwhelming majority of this file), a line the worker
 * wrote that is not JSON at all, and JSON that is not an object. None of them
 * is a finding — a ledger full of verb decisions is a ledger doing its job.
 */
function parseHoneypotLine(line: string): HoneypotLine | null {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    return null;
  }
  if (typeof value !== "object" || value === null) return null;
  const event = (value as { event?: unknown }).event;
  if (typeof event !== "string") return null;
  if (event !== ARMED && event !== ATTEMPT && event !== FLOOD) return null;
  return { event, ts: (value as { ts?: unknown }).ts };
}

/** A row's own timestamp if it has a usable one, else null. */
function stamp(row: HoneypotLine): string | null {
  return typeof row.ts === "string" && row.ts !== "" ? row.ts : null;
}

/**
 * Summarize one worker's honeypot evidence.
 *
 * Never throws and never reports "unknown": the absence of evidence IS the
 * `armed: false` answer, and a caller that had to handle a third return shape
 * would be one `if` away from treating a missing file as fine.
 */
export function summarizeEscapeWatch(
  worker: string,
  records: readonly CollectedVerbgateRecord[],
): EscapeWatch {
  let armed = false;
  let attempts = 0;
  let flooded = false;
  let first: string | null = null;
  let last: string | null = null;

  for (const rec of records) {
    // Only `row` records carry worker bytes. A `truncation` mark is the
    // collector's own record about the file and says nothing about the
    // honeypot — it is reported through ISC-172's surface, not this one.
    if (rec.kind !== "row") continue;
    const row = parseHoneypotLine(rec.line);
    if (row === null) continue;
    if (row.event === ARMED) {
      armed = true;
      continue;
    }
    if (row.event === FLOOD) {
      flooded = true;
      continue;
    }
    attempts += 1;
    const at = stamp(row);
    if (at !== null) {
      // `first`/`last` follow the order rows were COLLECTED in rather than
      // sorting by timestamp, because the timestamp is worker-authored and
      // sorting on it would let a forged row rewrite the window. Collection
      // order is the host's.
      if (first === null) first = at;
      last = at;
    }
  }

  return EscapeWatchSchema.parse({
    worker,
    armed,
    attempts,
    flooded,
    first_attempt_at: first,
    last_attempt_at: last,
  });
}

/**
 * Whether a watch record needs an operator's attention.
 *
 * BOTH states qualify and that is the point of the function existing: a worker
 * that was never watched is as much a finding as one that was caught trying,
 * and a renderer that keyed on `attempts > 0` alone would print a clean report
 * for a run whose detector never came up.
 */
export function escapeWatchIsFinding(w: EscapeWatch): boolean {
  return !w.armed || w.attempts > 0;
}
