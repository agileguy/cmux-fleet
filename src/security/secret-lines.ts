/**
 * The LINES of a multi-line secret that are themselves secret material.
 *
 * ## Why this is one function with two callers
 *
 * Commit 8bcb1ed let an allowlisted secret opt in to multi-line values
 * (`multiline: true` in `config/schema.ts`), for the observer roles' OpenSSH
 * key, known_hosts list and targets list. Two consumers then need the same
 * answer about such a value: the harvest credential sweep
 * (`harvest/needles.ts`), which looks for each line as a literal needle, and
 * the event-log redactor (`security/redact.ts`), which scrubs each line out of
 * `events.jsonl`. A key leaks one line at a time (`head -3`, an ssh error
 * echoing a line), so the whole value is not enough for either.
 *
 * This repo has already paid once for two modules that answered one secret
 * question separately: `security/secret-values.ts` exists because both readers
 * went blind when delivery moved and each one's tests stayed green. So the line
 * and armor rules live here, once.
 *
 * ## What it does NOT share: the floor
 *
 * Each caller passes its own. The sweep's `MIN_NEEDLE_BYTES` and the
 * redactor's `MIN_REDACTABLE_LENGTH` are separate constants chosen against
 * separate failures (a finding on every harvest, a marker in every log line),
 * and they happen to hold the same number today. Folding them into one would
 * couple a report policy to a log policy.
 */

/**
 * A PEM armor line: `-----BEGIN OPENSSH PRIVATE KEY-----`, `-----END RSA
 * PRIVATE KEY-----`, `-----BEGIN PGP PRIVATE KEY BLOCK-----` and their kin.
 * Public text, identical in every key of its type, so never secret material.
 */
const ARMOR_LINE = /^-----(?:BEGIN|END)[A-Z0-9 ]*-----$/;

/** Whether a TRIMMED line is PEM armor. */
export function isArmorLine(line: string): boolean {
  return ARMOR_LINE.test(line);
}

/**
 * Each line of `value` that is secret material, in order, without repeats.
 *
 * A secret line is TRIMMED, NOT BLANK, NOT PEM ARMOR, and at least `floor`
 * characters long.
 *
 * - Trimmed, because a trimmed line is a substring of the original, so it
 *   matches strictly more; delivery refuses CR, so a current run holds no `\r`
 *   to strip anyway.
 * - Not blank, because an empty needle matches everywhere.
 * - Not armor, because armor appears in every key of a type and in honest
 *   prose about keys ("the host rejected a BEGIN OPENSSH PRIVATE KEY block").
 * - Over the caller's floor, for the reason each caller gives for its own.
 *
 * A value with NO LF has no lines in this sense and yields `[]`. Callers match
 * a single-line value whole, as they always did; returning its trimmed self
 * here would quietly add a second form for every token with a trailing space.
 *
 * One cost is stated rather than hidden. An OpenSSH key's first body line
 * encodes a header that is the same for every unencrypted key of its type, so
 * it is not secret either. It is still returned: the only text that carries it
 * is text quoting key material.
 */
export function secretLines(value: string, floor: number): string[] {
  if (!value.includes("\n")) return [];
  const out: string[] = [];
  for (const raw of value.split("\n")) {
    const line = raw.trim();
    if (line === "" || line.length < floor || isArmorLine(line) || out.includes(line)) continue;
    out.push(line);
  }
  return out;
}
