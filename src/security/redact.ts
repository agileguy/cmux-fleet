/**
 * Scrub granted secret VALUES out of the supervisor's event log (SRD §12.4).
 *
 * ## The measurement that produced this file
 *
 * On 2026-08-28 a `ticketing` worker was told — in its role prompt AND in the
 * `ticket-ops` skill mounted into it — never to echo its credential. Its
 * SECOND command was `echo $TICKET_API_TOKEN | head -c 20`. The full
 * 41-character value then existed in three places on the host:
 *
 *   - `<run>/workers/<id>/events.jsonl`      mode 0644
 *   - `<run>/sessions/<ts>_<id>.jsonl`       mode 0644
 *   - `<run>/workers/<id>/env`               mode 0600  ← the only intended one
 *
 * The fields carrying it were `tool_execution_update.partialResult.
 * content[0].text`, `tool_execution_end.result.content[0].text` and
 * `message_start.message.content[0].text`.
 *
 * The lesson is the one this repo already applies to markup and to mounts: **a
 * prompt-level prohibition is not a control.** An instruction is advice to a
 * sampler; the only thing that holds is a structure the worker cannot route
 * around. So the value is removed on the way to disk, by the process that owns
 * the disk, and the worker's compliance stops being part of the story.
 *
 * ## Why the SERIALISED FORM and not a field walker
 *
 * The three fields above are the ones OBSERVED, not the ones that exist. A
 * walker that knows about `result.content[0].text` is correct until Pi emits a
 * fourth shape, and it fails SILENTLY — a new event type leaks and every test
 * over the three known ones stays green. Scrubbing the JSON text cannot be
 * out-flanked that way: whatever the record's shape, the value is a substring
 * of the line or it is not in the line at all. (For a value spanning lines,
 * read "value" as "each secret line of it"; see the multi-line section below.)
 *
 * That choice sets the matching rule. Inside a JSON document a string appears
 * ESCAPED, so the needle is `JSON.stringify(v).slice(1,-1)` and not `v`. The
 * raw form is deliberately NOT matched: for an ordinary token the two are the
 * same string, and for a value containing `\` or `"` the raw form cannot occur
 * in the serialised text at all while a match on it could straddle an escape
 * sequence and leave behind JSON that no longer parses. The double-escaped
 * form is matched as well, which is how a value survives being embedded in a
 * record as pre-serialised JSON — a shape Pi produces whenever a tool result
 * is itself a JSON document.
 *
 * ## Why a minimum length, stated as a failure rather than a nicety
 *
 * A one-character secret matches everywhere. Armed naively, `TOKEN=a` turns
 * every `a` in the log into a marker: the credential is protected and the
 * observability is destroyed, which is a denial of service on the operator by
 * the operator. `MIN_REDACTABLE_LENGTH` is the floor, and a value under it is
 * skipped and REPORTED BY NAME rather than dropped in silence — an operator
 * whose token is not being scrubbed has to be able to find that out. The same
 * guard makes an empty value a no-op instead of a match at every offset, which
 * is `findCredentialLeaks`'s reasoning in `contracts.ts` applied to the
 * writing side rather than the reading side.
 *
 * ## Multi-line values: matched line by line, and never by their armor
 *
 * A `multiline: true` CREDENTIAL grant — the observer roles' OpenSSH key is
 * the shipped case (SRD-OBSERVER-ROLES §5.5 also marks that role's
 * known_hosts list and targets list `multiline: true`, but both `credential:
 * false`, so `worker-env.ts` never arms this module for them at all; see the
 * `TRUNCATION_FLOOR` cost note below) — leaks one line at a time far more
 * often than whole: `head -3 key`, an ssh error echoing the line it choked
 * on. Inside JSON the value's
 * LF is `\n`, so the whole value is not a substring of a record quoting one
 * line of it, and a redactor that compiled only the whole value let exactly
 * that record through unchanged. So a value containing LF compiles:
 *
 *   - the WHOLE value, escaped and double-escaped, matched IN FULL only; and
 *   - each SECRET LINE (trimmed, non-blank, not PEM armor, at least
 *     `MIN_REDACTABLE_LENGTH`; see `security/secret-lines.ts`), escaped and
 *     double-escaped, matched whole or truncated down to `TRUNCATION_FLOOR`
 *     exactly as a single-line value is.
 *
 * The whole value does not truncate, and that is what keeps armor out. Its
 * leading run is its first line, which for a key is `-----BEGIN OPENSSH
 * PRIVATE KEY-----`: public, identical in every key of the type, and present
 * in honest prose about keys. A twelve-character stem of it turned "sshd said:
 * -----BEGIN OPENSSH PRIVATE KEY----- block rejected" into a marker. Dropping
 * the truncation costs nothing a line form does not cover, because a truncated
 * copy of the whole value is a run of whole lines ending in one cut line, and
 * each secret line in it matches its own form down to the floor. Armor lines
 * are never line forms. So for a well-formed key, nothing compiled from it
 * matches text whose only overlap with the key is armor. A line that merely
 * STARTS like armor but is not armor-shaped is matched like any other line.
 *
 * Full-only once also kept a key clear of a flaw in truncation across the two
 * forms. The double-escaped form is the longer, so it sorted first, in an
 * alternation that took the first match rather than the longest. Its stem
 * could match a single-escaped record up to the first escape and win with the
 * shorter match, cutting the escape in half and leaving the rest of the value
 * beside the marker. That hit any truncatable form whose first `"` or `\` sits
 * past the floor: a single-line value, or a secret line, carrying one. It no
 * longer applies to any form; the next section says why.
 *
 * The line rules are shared with the harvest sweep (`harvest/needles.ts`) so
 * the two cannot disagree about what a secret line is. The floors are not
 * shared. A multi-line name is armed ONCE however many lines it contributes,
 * and every form it compiles carries its one marker.
 *
 * ## Which match is replaced: the longest, and only between escapes
 *
 * Several forms can match at one position: a value's escaped and double-escaped
 * forms, two values sharing a stem, two lines of one value. What is replaced
 * there is the LONGEST match any of them produces, and on a tie the form that
 * sorts first. Regex alternation cannot make that choice, because it takes the
 * first alternative that matches. So `buildRedactor` uses the alternation only
 * to find the next hit, then tries every form at that one position.
 *
 * A replacement never ends inside an escape sequence of the line, and never
 * starts inside one. Truncation steps a whole token at a time (one character,
 * or one escape such as `\n`), so a match that starts on a token boundary ends
 * on one. A hit that starts inside an escape, on the `n` of `\n`, is not a
 * leading run of anything and is passed over. Either kind of cut used to leave
 * a lone backslash in the line or change the character after the marker.
 *
 * One level down, for a JSON document embedded in a record as a string, the
 * double-escaped form truncates by the DOCUMENT's tokens rather than the
 * line's (see `truncationSource`), so a truncated match of it never ends
 * inside one of the document's escapes.
 *
 * THE RESIDUAL, SAID OUT LOUD: a replacement can still leave an embedded
 * document that no longer parses, in two ways older than that fix. A hit can
 * start inside one of the document's escapes. And a value holding a quote or a
 * backslash can line its SINGLE-escaped form up with the document's own
 * closing quote or escape, which then goes with the match. The line itself
 * always parses. Neither is closed here, because the same bytes also read as
 * raw text, where that match is a real leading run: stopping it short leaves
 * the rest of the value in the log, and widening it takes characters that are
 * not the value's. Telling the two readings apart means parsing the string
 * the hit sits in.
 *
 * ## Cost
 *
 * This runs on EVERY event, including a `stderr_line` flood — ISC-158's
 * scenario emits thousands. So every regex is compiled ONCE, at construction,
 * however many lines a value contributes: the alternation, and one sticky
 * matcher per form. A line holding no secret costs one scan of the
 * alternation, as it always did. Only a line with a hit pays more. Per hit,
 * that is a backward look over at most the backslashes before it, and one
 * sticky attempt per form, stopping at the first form too short to beat the
 * best match so far.
 * Nothing here allocates a `RegExp` per event, and a worker granted no secrets
 * gets an identity function rather than a regex that matches nothing.
 */

import { secretLines } from "./secret-lines.ts";

/**
 * Shortest value that is scrubbed. Below this the needle is more likely to be
 * noise than a credential, and a needle that matches noise eats the log.
 *
 * Eight, not one, and not thirty-two: real tokens are long (the leaked one was
 * 41 characters), while an eight-character value is short enough that an
 * operator who chose it should hear that it is not being protected.
 */
export const MIN_REDACTABLE_LENGTH = 8;

/**
 * Shortest LEADING FRAGMENT of a value that is still scrubbed.
 *
 * Twelve, and the number is a trade rather than a preference. The incident
 * that produced this module ended in `head -c 20`, so anything above twenty
 * would have missed the actual leak; anything much below twelve starts to
 * matter for a LOW-ENTROPY secret, whose first eight characters may be an
 * ordinary English word that then gets scrubbed out of every line of the log.
 * Twelve characters of a random token is a fragment worth removing and twelve
 * characters of prose is rare enough not to carpet the file.
 *
 * THE RESIDUAL, SAID OUT LOUD: a fragment shorter than this is NOT scrubbed,
 * and neither is a fragment taken from the middle or the END of a value
 * (`tail -c 20`). Only leading runs are matched: of a single-line value, and
 * of each secret line of a multi-line one. Matching per line moves that
 * boundary; it does not remove it. A multi-line value's middle and last LINES
 * are covered (`sed -n 5p key`), which a leading-run-of-the-value rule could
 * not do. The middle or end of any ONE line still is not (`tail -c 20 key`, a
 * line a tool wrapped or cut partway), and neither is a line under
 * `MIN_REDACTABLE_LENGTH`, nor an armor line, which is public by design.
 * Covering arbitrary substrings means a needle per window, which is the
 * log-eating failure at scale and the cost this whole module is shaped around
 * avoiding.
 *
 * Per-line matching has a cost of its own, paid by any multi-line CREDENTIAL
 * whose lines share a leading run. Any leading run of twelve or more
 * characters of an armed line is replaced, including one that also matches a
 * DIFFERENT armed line's own leading run, or an unrelated line of honest
 * prose that happens to share it: `buildRedactor` sees only the `(name,
 * value)` pairs it is handed, has no notion of `credential: false`, and pays
 * this cost uniformly for whatever it is armed against — with
 * `web-1 10.0.0.5 22 observer` armed, `web-1 10.0.0.7 is up` would log as
 * `[redacted:NAME]7 is up`.
 *
 * WHICH NAMES REACH THIS MODULE ARMED AT ALL is decided one layer up, in
 * `run/worker-env.ts`: a name the fleet declared `credential: false` never
 * enters `PIFLEET_SECRET_NAMES`, so `buildRedactor` never receives it and the
 * cost above is never paid for it. SRD-OBSERVER-ROLES §5.5's
 * `OBSERVER_DOCKER_KNOWN_HOSTS` and `OBSERVER_DOCKER_TARGETS` are the shipped
 * case — both `multiline: true` AND `credential: false` — so a known_hosts
 * host key or a "token host port user" targets line is delivered to the
 * worker and never scrubbed, whole or by line. Only a name that stayed a
 * credential, such as the same role's OpenSSH key, pays this module's cost at
 * all.
 */
export const TRUNCATION_FLOOR = 12;

/**
 * What replaces a match when the redactor cannot name what it matched.
 *
 * Unreachable through `buildRedactor`, which always has a name for every form
 * it compiled; it exists so the replace loop has a total answer rather than a
 * fallback that leaves the match in the line and so re-emits the secret on a
 * lookup miss.
 */
export const UNNAMED_MARKER = "[redacted]";

/** Where a redactor's needles came from, so an unarmed one can say why. */
export type RedactorSource = "store" | "env-file" | "absent" | "unreadable" | "none";

export interface Redactor {
  /** Names whose values are being scrubbed. NAMES ONLY — see `armed` below. */
  readonly armed: readonly string[];
  /** Names skipped for being empty or under `MIN_REDACTABLE_LENGTH`. */
  readonly skipped: readonly string[];
  /**
   * Names the run GRANTED that could not be valued from any layout.
   *
   * Distinct from `skipped`, and the distinction is the one this field was
   * added for. `skipped` means "found it, it is not worth redacting" — a short
   * region name, an empty flag. This means "was told to protect it and cannot
   * see it", which is not a policy decision but a BLINDING, and it is the
   * state a live credential reached an event log in while the redactor
   * reported itself armed for that exact variable.
   *
   * Non-empty here should be treated as a defect in the run, not a note.
   */
  readonly unresolved: readonly string[];
  /** Where the values came from. */
  readonly source: RedactorSource;
  /**
   * Scrub every occurrence of every armed value out of a serialised record.
   *
   * `serialised` must be `JSON.stringify` output, as it is at the only caller,
   * `appendJsonl`'s transform, because the escape checks read the parity of a
   * backslash run and in raw text would pass over a secret that follows an odd
   * run of backslashes.
   */
  redact(serialised: string): string;
}

/**
 * The variable through which `up` tells the supervisor WHICH of a worker's
 * environment entries are credentials.
 *
 * It rides the env file rather than a sibling JSON file, and that is the whole
 * design. The names and the values then live in ONE artifact, written by ONE
 * call (`writeWorkerEnvFile`), so they cannot drift apart — the failure a
 * second file invites is a stale name list that arms the redactor against a
 * rotated value and reports itself as armed while scrubbing nothing.
 *
 * ISC-333 records the same need from the harvest side and names the same
 * blocker: `WorkerEnvPlan.secretNames` "is reported to stderr and persisted
 * nowhere". This is the persistence, placed where the values already are.
 *
 * The container sees it. That is zero new information — a worker holding
 * `TICKET_API_TOKEN` already knows it holds `TICKET_API_TOKEN` — and the
 * `PIFLEET_` prefix is already reserved, so no worker can request the name and
 * substitute its own list.
 */
export const SECRET_NAMES_VAR = "PIFLEET_SECRET_NAMES";

const NAME_UNSAFE = /[^A-Za-z0-9_]/g;
const RE_META = /[.*+?^${}()|[\]\\]/g;

/** How `value` appears INSIDE a JSON string — the only form JSON text holds. */
function jsonInner(value: string): string {
  const quoted = JSON.stringify(value);
  return quoted.slice(1, quoted.length - 1);
}

function escapeRe(s: string): string {
  return s.replace(RE_META, "\\$&");
}

const BACKSLASH = 0x5c;
const LOWER_U = 0x75;
const HIGH_SURROGATE_START = 0xd800;
const HIGH_SURROGATE_END = 0xdbff;
const LOW_SURROGATE_START = 0xdc00;
const LOW_SURROGATE_END = 0xdfff;

function isHighSurrogate(c: number): boolean {
  return c >= HIGH_SURROGATE_START && c <= HIGH_SURROGATE_END;
}

function isLowSurrogate(c: number): boolean {
  return c >= LOW_SURROGATE_START && c <= LOW_SURROGATE_END;
}

/**
 * Length of the JSON string token that starts at `i`: six for a unicode escape
 * (a backslash, `u`, four hex digits), two for any other escape, TWO for an
 * intact UTF-16 surrogate pair, one otherwise. `i` must itself be a token
 * boundary.
 *
 * ## The measurement that added the surrogate case
 *
 * JSON.stringify does not escape an astral character (anything outside the
 * BMP — an emoji, among other things): it serialises it as the two raw UTF-16
 * code units the JS string already holds, a high surrogate immediately
 * followed by its low surrogate. Before this, `tokenLength` returned 1 for
 * BOTH of those units, so `jsonTokens` split one codepoint into two
 * INDEPENDENT tokens. `truncationSource` then built a stem or an optional
 * tail group that could end on the high surrogate alone — and every astral
 * codepoint in the same 1,024-wide block shares that high surrogate, so a
 * pattern truncated there matched ANY codepoint of that block, not only the
 * secret's own. Measured: secret `…abcdefghijk` + U+1F600 (a grinning face,
 * D83D DE00) armed a form whose 12-character floor landed exactly on D83D. A
 * record holding the SAME 11 characters followed by a DIFFERENT emoji from
 * the same block — U+1F601, D83D DE01 — matched up through D83D and stopped:
 * the marker replaced the shared run, and the record's own DE01 was left
 * behind with nothing before it. `JSON.parse` accepts a lone low surrogate,
 * so the break was invisible until the line was re-encoded to UTF-8 and the
 * orphan became U+FFFD (`EF BF BD`) — a byte sequence with no relation to
 * either codepoint.
 *
 * A high surrogate immediately followed by its own low surrogate is now ONE
 * token, exactly as a `\uXXXX` escape already was. `truncationSource` never
 * sees the codepoint in pieces: a stem that needs part of it to reach
 * `TRUNCATION_FLOOR` takes the WHOLE pair, and an optional tail group either
 * matches the exact codepoint or does not match at all — it can no longer
 * stop halfway through one. A lone (unpaired) surrogate — not preceded or
 * followed by its other half — is not a pair and falls through to the
 * ordinary one-unit case, which is correct: nothing here can turn an already
 * malformed string well-formed, and nothing here is asked to.
 */
function tokenLength(text: string, i: number): number {
  const c = text.charCodeAt(i);
  if (c === BACKSLASH) return text.charCodeAt(i + 1) === LOWER_U ? 6 : 2;
  if (isHighSurrogate(c) && isLowSurrogate(text.charCodeAt(i + 1))) return 2;
  return 1;
}

/** JSON string text split into its tokens: single characters and whole escapes. */
function jsonTokens(inner: string): string[] {
  const tokens: string[] = [];
  for (let i = 0; i < inner.length; ) {
    const n = tokenLength(inner, i);
    tokens.push(inner.slice(i, i + n));
    i += n;
  }
  return tokens;
}

/** How many backslashes end at index `end`, counting back no further than `from`. */
function backslashesEndingAt(text: string, end: number, from: number): number {
  let i = end;
  while (i >= from && text.charCodeAt(i) === BACKSLASH) i--;
  return end - i;
}

/**
 * Where the escape that index `pos` falls strictly INSIDE begins, or -1 when
 * `pos` sits on a boundary between the serialised line's tokens.
 *
 * `from` must be a known boundary at or before `pos`, and nothing before it is
 * read. `redact` moves `from` past every hit it handles, so across one call
 * these backward looks read each character of the line a constant number of
 * times, however many hits it has. Serialised JSON holds a backslash only as the first character of an
 * escape or the second character of `\\`, so the parity of the backslash run
 * ending just before a position says whether that run's last backslash opened
 * an escape.
 */
function escapeContaining(text: string, pos: number, from: number): number {
  if (backslashesEndingAt(text, pos - 1, from) % 2 === 1) return pos - 1;
  for (let start = pos - 2; start >= from && start >= pos - 5; start--) {
    if (text.charCodeAt(start + 1) === LOWER_U && backslashesEndingAt(text, start, from) % 2 === 1) {
      return start;
    }
  }
  return -1;
}

/**
 * A pattern matching any leading run of `form` at least `floor` long that ends
 * on a token boundary, preferring the longest.
 *
 * ## The measurement that added this
 *
 * The first version of this module matched whole values, and the wiring test
 * that drives a real supervisor caught it on the first run. The command in the
 * 2026-08-28 incident was not `echo $TICKET_API_TOKEN`. It was
 *
 *     echo $TICKET_API_TOKEN | head -c 20
 *
 * — the model truncated the value *because it had been told not to echo it*.
 * A whole-value scrubber sails past that and leaves twenty characters of a
 * live credential in the log while reporting itself armed. Truncation is not
 * an exotic case to defend against; it is the FIRST thing a model told "do not
 * print the secret" reaches for, so a control that a one-word pipe defeats is
 * not a control.
 *
 * ## Why nested optionals rather than an alternation of every prefix
 *
 * Listing all 30 prefixes of a 41-character token as alternatives is simpler
 * to read and unusable in this position: alternation backtracks, so a
 * `stderr_line` flood of 8MB lines would be scanned once per alternative. This
 * emits ONE alternative per form —
 *
 *     abcdefghijkl(?:m(?:n(?:o)?)?)?
 *
 * — which the engine walks in a single linear pass, and which is greedy by
 * construction (`?` prefers to match), so the pattern takes the LONGEST
 * surviving fragment of THIS form rather than the shortest. Which form wins
 * when several match at one position is a different question, and
 * `buildRedactor` answers it.
 *
 * ## Why one TOKEN at a time and not one character
 *
 * `form` is JSON string text, so some of its runs are escapes: a backslash and
 * a quote, two backslashes, `\n`, a unicode escape. A cut inside one is not a
 * leading run of the value; it is half a character of JSON. Stepping one
 * character at a time let a truncation end there, and the replacement took a
 * lone backslash out of the record, which either stopped the line parsing or
 * changed the character after the marker. So each optional adds one whole
 * token, and the stem is widened to the first token boundary at or past
 * `floor`. A real fragment loses nothing by that: it is a raw prefix of the
 * value, so its escaped form always ends on a boundary. For a form with no
 * escapes every token is one character and the pattern is byte-for-byte what
 * it was.
 *
 * ## Whose tokens: the escaped form's, for BOTH forms
 *
 * `tokens` is the escaped form split into its tokens, and for the
 * double-escaped form, each of those tokens double-escaped as a unit. This used
 * to tokenise the double-escaped text itself, which steps the LINE's tokens,
 * and one escape of a document embedded in the record is several of those:
 * the document's escaped quote is an escaped backslash and then an escaped
 * quote in the line. A truncation could stop between the two. The line still
 * parsed and the embedded document did not. A reviewer's fuzz measured it on
 * 640eb1e: 192 of 40,000 records, with no stem left behind in any of them.
 *
 * Stepping the document's tokens ends every truncation where one of the
 * document's characters ends. A real fragment loses nothing, for the reason
 * above one level down: its double-escaped form ends on a document boundary.
 * Every document boundary is also a line boundary, so the pattern matches a
 * subset of what it did. What it no longer matches is text that shares a
 * value's first characters and then DIFFERS inside one escape of the document,
 * where the old pattern took the shared run together with half that escape.
 * The shared run is a raw leading run under the floor in that form, which is
 * the same answer the escaped form already gave inside its own escapes.
 */
function truncationSource(tokens: readonly string[], floor: number): string {
  let stemTokens = 0;
  let stem = "";
  while (stem.length < floor) stem += tokens[stemTokens++] as string;
  let tail = "";
  for (let i = tokens.length - 1; i >= stemTokens; i--) {
    tail = `(?:${escapeRe(tokens[i] as string)}${tail})?`;
  }
  return escapeRe(stem) + tail;
}

/**
 * Compile a redactor from `(name, value)` pairs.
 *
 * The marker NAMES the variable: `[redacted:TICKET_API_TOKEN]`. That is a
 * deliberate call and the argument for it is rotation. A leak that has been
 * scrubbed still happened — the worker did echo the token — and the operator's
 * next action is to rotate the credential that reached model output. An
 * unnamed marker in a fleet holding four grants tells them to rotate four
 * things or none. The name is not the secret and is not new here:
 * `materialize.ts` already prints `secretNames` to stderr at `up` by design,
 * and `WorkerEnvPlan` splits names from values into two fields precisely so a
 * reporting surface can carry a name without being able to reach a value.
 *
 * The name is sanitised into the marker anyway (`[^A-Za-z0-9_]` -> `_`). Names
 * reaching here have passed `ENV_KEY_RE`, so nothing should change; a marker
 * able to carry a quote or a backslash would be a way to break the JSON this
 * function exists to leave intact, and that is not a property worth resting on
 * a validator two modules away.
 */
export function buildRedactor(
  secrets: Iterable<readonly [string, string]>,
  source: RedactorSource = "env-file",
  /**
   * Granted names that could not be VALUED at all — passed through to the
   * result rather than computed here, because this function is handed pairs
   * and by then the unresolvable ones are already gone. The caller that
   * resolved them is the only one that can still see them.
   */
  unresolved: readonly string[] = [],
): Redactor {
  /** Each form's regex source, marker and full length, in compile order. */
  const forms: Array<{ src: string; marker: string; len: number }> = [];
  const seen = new Set<string>();
  const armed: string[] = [];
  const skipped: string[] = [];

  /**
   * Compile `text`'s escaped and double-escaped forms under one marker, both
   * truncating by the escaped form's tokens (see `truncationSource`).
   */
  const addForms = (text: string, marker: string, truncatable: boolean): void => {
    const escaped = jsonTokens(jsonInner(text));
    for (const tokens of [escaped, escaped.map(jsonInner)]) {
      const form = tokens.join("");
      if (form.length < MIN_REDACTABLE_LENGTH) continue;
      /*
       * `min` and not `TRUNCATION_FLOOR` outright: a secret SHORTER than the
       * floor gets whole-value matching and no fragment matching at all. That
       * is the direction the guard has to fail in — the shorter the value, the
       * likelier a leading run of it is ordinary text, and a needle that
       * matches ordinary text eats the log it was meant to protect.
       */
      const floor = truncatable ? Math.min(TRUNCATION_FLOOR, form.length) : form.length;
      const src = truncationSource(tokens, floor);
      /*
       * Keyed on the PATTERN, not the form's text. One value's escaped form can
       * be another's double-escaped form, the same text tokenised two ways, and
       * each pattern matches leading runs the other does not.
       */
      if (seen.has(src)) continue;
      seen.add(src);
      forms.push({ src, marker, len: form.length });
    }
  };

  for (const [name, value] of secrets) {
    if (typeof value !== "string" || value.length < MIN_REDACTABLE_LENGTH) {
      skipped.push(name);
      continue;
    }
    const marker = `[redacted:${name.replace(NAME_UNSAFE, "_")}]`;
    /*
     * A value with no LF compiles exactly what it always did: its two forms,
     * truncatable, and `secretLines` yields nothing for it. A value WITH one is
     * matched whole only IN FULL, because its leading run is its first line and
     * for a key that is public armor. Its secret lines carry the truncation
     * instead. The module header's multi-line section says why that loses
     * nothing.
     */
    addForms(value, marker, !value.includes("\n"));
    for (const line of secretLines(value, MIN_REDACTABLE_LENGTH)) addForms(line, marker, true);
    armed.push(name);
  }

  if (forms.length === 0) {
    return { armed, skipped, unresolved, source, redact: (s) => s };
  }

  /*
   * WHICH MATCH WINS: the longest at its position, and the earlier form on a
   * tie.
   *
   * Regex alternation is first-match-wins, not longest-match-wins, so an
   * alternation of every form cannot make that choice itself. It used to be
   * asked to, sorted longest form first, and it failed whenever a longer FORM
   * produced a shorter MATCH. The double-escaped form of a value holding a `"`
   * past the stem matched a single-escaped record up to the quote, won, and
   * left the rest of the value in the log beside the marker (measured on
   * c9bcf33). Two values sharing a stem failed the same way, leaving a partial
   * credential and a false impression that it was handled.
   *
   * So the work is split. `finder`, the alternation, only says WHERE the next
   * hit is. It is the one scan a line holding no secret pays for, as before. At
   * a hit, each form's sticky twin is tried at that one position and the
   * longest match is replaced. Sorting longest form first still earns its
   * place: a form no longer than the best match so far cannot beat it, so the
   * loop stops there, and on a tie the earlier form's marker wins, as it did
   * under the alternation. Both kinds of regex are built here, once.
   */
  forms.sort((a, b) => b.len - a.len);
  const finder = new RegExp(forms.map((f) => `(?:${f.src})`).join("|"), "g");
  const compiled = forms.map((f) => ({
    sticky: new RegExp(f.src, "y"),
    marker: f.marker,
    len: f.len,
  }));

  return {
    armed,
    skipped,
    unresolved,
    source,
    redact(serialised: string): string {
      finder.lastIndex = 0;
      let hit = finder.exec(serialised);
      if (hit === null) return serialised;
      let out = "";
      /** Everything before this index is already in `out`. Always a token boundary. */
      let kept = 0;
      /** A token boundary at or before the next hit, so the escape check reads no further back. */
      let boundary = 0;
      while (hit !== null) {
        const at = hit.index;
        const inside = escapeContaining(serialised, at, boundary);
        if (inside >= 0) {
          /*
           * The hit STARTS inside an escape, on the `n` of a `\n` for instance.
           * The text from there is not a leading run of any value, and
           * replacing from it would orphan the backslash. Resume after that
           * escape.
           */
          boundary = inside + tokenLength(serialised, inside);
          finder.lastIndex = boundary;
        } else {
          let best = 0;
          let marker = UNNAMED_MARKER;
          for (const form of compiled) {
            if (form.len <= best) break;
            form.sticky.lastIndex = at;
            const m = form.sticky.exec(serialised);
            if (m !== null && m[0].length > best) {
              best = m[0].length;
              marker = form.marker;
            }
          }
          /*
           * Unreachable: the finder matched here, so the sticky twin of the
           * form that matched does too. Were it reached, the finder's own match
           * is replaced under the unnamed marker rather than left in the line.
           */
          if (best === 0) best = hit[0].length;
          out += serialised.slice(kept, at) + marker;
          kept = at + best;
          boundary = kept;
          finder.lastIndex = kept;
        }
        hit = finder.exec(serialised);
      }
      return out + serialised.slice(kept);
    },
  };
}

/** A redactor that scrubs nothing, for a worker granted nothing. */
export function noRedaction(source: RedactorSource = "none"): Redactor {
  return { armed: [], skipped: [], unresolved: [], source, redact: (s) => s };
}

/**
 * Parse docker's `--env-file` format back into a map.
 *
 * The inverse of `serializeEnvFile`, and only that: the writer refuses
 * newlines and emits no quoting or escaping, so a reader that split on the
 * first `=` and stopped is the exact inverse. Anything richer would be a
 * SECOND dialect — the value would come back different from the one written,
 * on the one file where a wrong value means the redactor arms a needle that
 * never matches and reports itself armed.
 */
export { parseEnvFile } from "./secret-values.ts";
import { parseEnvFile, resolveGrantedSecretValues } from "./secret-values.ts";

/**
 * Build the redactor for one worker from its own 0600 env file.
 *
 * ABSENCE IS NOT AN ERROR and must not be one. A supervisor launched straight
 * at a bare run directory — which every integration test does, and which is a
 * supported way to run the double — has no env file, and a supervisor that
 * refused to start over a missing redactor would trade a leak for a fleet that
 * does not run. It returns an unarmed redactor that SAYS WHY, and the
 * supervisor logs that, so "not redacting" is a visible state rather than an
 * assumed one.
 *
 * The values are held in this process for its lifetime, which is a real cost
 * and is the same trade ISC-333 declined to make in the harvester. It is
 * accepted HERE and refused THERE for one reason: the supervisor is already
 * the process that wrote the env file's contents into a container's argv, so
 * holding them adds no reach, whereas the harvester is a separate process that
 * would have to acquire plaintext credentials it does not otherwise touch.
 */
export async function redactorForWorkerEnv(
  envFilePath: string,
  /**
   * The per-worker secret store, which is where granted values ACTUALLY live
   * since ISC-337..342 moved them out of the environment.
   *
   * A SECOND parameter and not a replacement, and required rather than
   * optional. Optional would have let every existing call site keep compiling
   * unchanged while silently continuing to read a file that no longer holds
   * what it is looking for — which is exactly how this defect shipped. Making
   * it required turns the delivery change into a compile error at each caller,
   * so the next person who moves the values is told where to look.
   */
  secretsDir: string,
): Promise<Redactor> {
  let text: string;
  try {
    text = await Bun.file(envFilePath).text();
  } catch (err) {
    const code = (err as { code?: string }).code;
    return noRedaction(code === "ENOENT" ? "absent" : "unreadable");
  }
  /*
   * The NAMES still come from the env file, and only the names. That is the
   * half of `SECRET_NAMES_VAR`'s original design which survived delivery
   * moving: a worker holding `TICKET_API_TOKEN` already knows it holds
   * `TICKET_API_TOKEN`, so the list costs nothing to expose, and the
   * `PIFLEET_` prefix is reserved so no worker can substitute its own.
   */
  const names = (parseEnvFile(text).get(SECRET_NAMES_VAR) ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  if (names.length === 0) return buildRedactor([], "env-file");

  /*
   * The VALUES come from the shared resolver, which reads the store first and
   * the env file second. Shared and not reimplemented here: this module and
   * `harvest/needles.ts` both need the same answer, they were written
   * separately, and when delivery moved BOTH went blind while each one's tests
   * stayed green. One function is what stops the next move from having to be
   * remembered in two places.
   */
  const resolved = await resolveGrantedSecretValues(secretsDir, envFilePath, names);
  const source: RedactorSource = resolved.source === "none" ? "env-file" : resolved.source;
  /*
   * `unresolved` is CARRIED, not dropped. The line this replaced was
   * `if (value === undefined) continue;`, justified on the reasoning that a
   * name without a value in the same file "cannot happen while they share a
   * file". They stopped sharing a file, the impossible case became the normal
   * one, and a `continue` turned a blinded redactor into a silent one.
   */
  return buildRedactor([...resolved.values], source, resolved.unresolved);
}
