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
 * of the line or it is not in the line at all.
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
 * ## Cost
 *
 * This runs on EVERY event, including a `stderr_line` flood — ISC-158's
 * scenario emits thousands. So the alternation is compiled ONCE, at
 * construction, and a call is one `String.replace` over one pre-built regex.
 * Nothing here allocates a `RegExp` per event, and a worker granted no secrets
 * gets an identity function rather than a regex that matches nothing.
 */

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
 * What replaces a match when the redactor cannot name what it matched.
 *
 * Unreachable through `buildRedactor`, which always has a name for every form
 * it compiled; it exists so the replace callback has a total answer rather
 * than a `?? match` fallback that would re-emit the secret on a lookup miss.
 */
export const UNNAMED_MARKER = "[redacted]";

/** Where a redactor's needles came from, so an unarmed one can say why. */
export type RedactorSource = "env-file" | "absent" | "unreadable" | "none";

export interface Redactor {
  /** Names whose values are being scrubbed. NAMES ONLY — see `armed` below. */
  readonly armed: readonly string[];
  /** Names skipped for being empty or under `MIN_REDACTABLE_LENGTH`. */
  readonly skipped: readonly string[];
  /** Where the values came from. */
  readonly source: RedactorSource;
  /** Scrub every occurrence of every armed value out of a serialised record. */
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

/**
 * Compile a redactor from `(name, value)` pairs.
 *
 * The marker NAMES the variable: `[redacted:TICKET_API_TOKEN]`. That is a
 * deliberate call and the argument for it is rotation. A leak that has been
 * scrubbed still happened — the worker did echo the token — and the operator's
 * next action is to rotate the credential that was exposed to model output. An
 * unnamed marker in a fleet holding four grants tells them to rotate four
 * things or none. The name itself is not the secret and is not new here:
 * `materialize.ts` already prints `secretNames` to stderr at `up` by design,
 * and `WorkerEnvPlan` splits names from values into two fields precisely so a
 * reporting surface can carry the name without being able to reach the value.
 *
 * The name is sanitised into the marker anyway (`[^A-Za-z0-9_]` → `_`). Names
 * reaching here have passed `ENV_KEY_RE`, so nothing should change; a marker
 * that could carry a quote or a backslash would be a way to break the JSON
 * this function's whole purpose is to write intact, and that is not a property
 * worth resting on a validator two modules away.
 */
export function buildRedactor(
  secrets: Iterable<readonly [string, string]>,
  source: RedactorSource = "env-file",
): Redactor {
  const byForm = new Map<string, string>();
  const armed: string[] = [];
  const skipped: string[] = [];

  for (const [name, value] of secrets) {
    if (typeof value !== "string" || value.length < MIN_REDACTABLE_LENGTH) {
      skipped.push(name);
      continue;
    }
    const marker = `[redacted:${name.replace(NAME_UNSAFE, "_")}]`;
    const inner = jsonInner(value);
    for (const form of [inner, jsonInner(inner)]) {
      // A form can only shrink below the floor if the floor changed under it;
      // re-checking costs nothing and keeps the guard true of what is compiled
      // rather than of what was handed in.
      if (form.length < MIN_REDACTABLE_LENGTH) continue;
      if (!byForm.has(form)) byForm.set(form, marker);
    }
    armed.push(name);
  }

  if (byForm.size === 0) {
    return { armed, skipped, source, redact: (s) => s };
  }

  /*
   * LONGEST FIRST. Regex alternation is first-match-wins, so two secrets where
   * one is a prefix of the other would otherwise leave the tail of the longer
   * one in the log beside a marker — a partial credential and a false sense
   * that it was handled.
   */
  const forms = [...byForm.keys()].sort((a, b) => b.length - a.length);
  const pattern = new RegExp(forms.map(escapeRe).join("|"), "g");

  return {
    armed,
    skipped,
    source,
    redact(serialised: string): string {
      return serialised.replace(pattern, (m) => byForm.get(m) ?? UNNAMED_MARKER);
    },
  };
}

/** A redactor that scrubs nothing, for a worker granted nothing. */
export function noRedaction(source: RedactorSource = "none"): Redactor {
  return { armed: [], skipped: [], source, redact: (s) => s };
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
export function parseEnvFile(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const line of text.split("\n")) {
    if (line === "" || line.startsWith("#")) continue;
    const eq = line.indexOf("=");
    if (eq <= 0) continue;
    out.set(line.slice(0, eq), line.slice(eq + 1));
  }
  return out;
}

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
export async function redactorForWorkerEnv(envFilePath: string): Promise<Redactor> {
  let text: string;
  try {
    text = await Bun.file(envFilePath).text();
  } catch (err) {
    const code = (err as { code?: string }).code;
    return noRedaction(code === "ENOENT" ? "absent" : "unreadable");
  }
  const vars = parseEnvFile(text);
  const names = (vars.get(SECRET_NAMES_VAR) ?? "")
    .split(",")
    .map((n) => n.trim())
    .filter((n) => n !== "");
  const pairs: Array<readonly [string, string]> = [];
  for (const name of names) {
    const value = vars.get(name);
    // A name with no value in the same file is a rotation or an edit between
    // the two halves of one write, which cannot happen while they share a
    // file. Skipped rather than thrown, and it shows up as an armed-name gap.
    if (value === undefined) continue;
    pairs.push([name, value]);
  }
  return buildRedactor(pairs, "env-file");
}
