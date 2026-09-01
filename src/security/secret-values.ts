/**
 * WHERE A GRANTED SECRET'S VALUE LIVES — asked and answered in exactly ONE
 * place (ISC-345).
 *
 * ## The bug this module is the shape of
 *
 * Two things in this repo need the VALUES of the secrets a worker was granted:
 * the event-log redactor, which scrubs them out of `events.jsonl`, and the
 * harvest credential sweep, which looks for them in the worker's own artifact.
 * Both read those values off disk at a moment when the config that produced
 * them is long gone.
 *
 * They were written independently, each with its own `parseEnvFile`, each
 * reading the worker's `--env-file`. When delivery moved to one file per secret
 * under `WorkerPaths.secretsDir` (ISC-337..342), the env file stopped carrying
 * values at all — it now holds `<NAME>_FILE=/secrets/<NAME>` — and BOTH readers
 * went blind. The sweep's blinding was caught before it shipped and fixed in
 * place (ISC-343). The redactor's was not, and it was found the only way it
 * could be: a live worker ran `cat` on the curl config it had just built, and
 * the credential landed in `events.jsonl` with the redactor reporting itself
 * armed for that exact variable.
 *
 * The lesson is not "check the other one too". Fixing the sweep in place left a
 * second reader that had to be REMEMBERED, and it was not. So this module
 * exists to make the question un-forgettable by making it un-duplicated: there
 * is now one function that knows where values live, and a future change to
 * delivery has one call site to follow rather than a set someone has to
 * enumerate correctly from memory.
 *
 * ## The invariant it restores
 *
 * `SECRET_NAMES_VAR`'s docstring in `redact.ts` states the design it was
 * protecting: names and values in ONE artifact written by ONE call, so they
 * "cannot drift apart", because the failure a split invites is "a stale name
 * list that arms the redactor against a rotated value and reports itself as
 * armed while scrubbing nothing."
 *
 * That prediction came true exactly. Delivery split the values into a second
 * location, the names stayed where they were, and the redactor armed against
 * three names while able to value one. The invariant cannot be restored by
 * putting the values back — they were moved for a reason that stands. It is
 * restored instead by making an unresolvable name a REPORTED FACT rather than a
 * `continue`, which is what `unresolved` below is for. A caller can still
 * choose to proceed; it can no longer proceed without being told.
 *
 * ## No `WorkerPaths`, deliberately
 *
 * This takes two plain paths. `run/worker-env.ts` already imports
 * `SECRET_NAMES_VAR` from `security/redact.ts`, so a `security` module that
 * imported `run/paths.ts` for a type would close a cycle for no benefit. The
 * two callers each hold a `WorkerPaths` and pass its two fields.
 */

import { open } from "node:fs/promises";
import { join } from "node:path";

/**
 * The shortest value worth resolving at all.
 *
 * Not a policy about what may be redacted or swept — each caller keeps its own
 * floor for that, and they differ for good reasons. This is only a floor on
 * what this module will hand back, and it exists so a zero-byte secret file
 * cannot become an empty-string needle that matches everything.
 */
export const MIN_RESOLVED_LENGTH = 1;

/** Bytes read from one secret file, or from the env file, before giving up. */
export const MAX_SECRET_READ_BYTES = 64 * 1024;

/** Where the values were actually found. */
export type SecretValueSource = "store" | "env-file" | "none";

export interface ResolvedSecrets {
  /** name -> value, for the names that resolved. */
  values: Map<string, string>;
  /** Which layout supplied them. */
  source: SecretValueSource;
  /**
   * Names that were GRANTED and could not be valued from either layout.
   *
   * Returned rather than skipped, because this is the field the whole module
   * exists for. A caller that arms itself on names and values them here will
   * otherwise report itself protecting something it is not touching — which is
   * precisely how a live credential reached an event log with the redactor
   * saying it was armed for that variable.
   */
  unresolved: string[];
}

/** Read at most `cap` bytes, or `null` if the path is not readable. */
async function readCapped(path: string, cap: number): Promise<string | null> {
  let handle;
  try {
    handle = await open(path, "r");
  } catch {
    return null;
  }
  try {
    const buf = Buffer.allocUnsafe(cap);
    const { bytesRead } = await handle.read(buf, 0, cap, 0);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => {});
  }
}

/**
 * Parse the env file the way DOCKER parses it, not the way a `.env` loader
 * would.
 *
 * `serializeEnvFile` writes `KEY=value` with no quoting and no escapes, because
 * `docker run --env-file` has none: it splits at the FIRST `=` and takes the
 * remainder verbatim. A parser that stripped quotes or honoured backslashes
 * would produce a value that is not the string in the container — and a value
 * one character off neither redacts nor matches, which fails silently and in
 * the direction that looks clean.
 *
 * Exported because `redact.ts` published its own copy of this before this
 * module existed and its tests pin the behaviour; that copy now delegates here
 * so the two cannot drift.
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
 * Resolve the VALUES for a set of granted names.
 *
 * The store is consulted FIRST and the env file only when the store yielded
 * nothing at all. Not "whichever has a value", and the order is written down
 * because the failure it prevents is the one that looks fine: after delivery
 * moved, a current run's env file carries `<NAME>_FILE` pointers, so a future
 * layout that put anything readable under the bare granted name there would
 * start supplying that instead of the credential — and the caller would redact,
 * or sweep for, a string that is not the secret.
 *
 * The env-file path is KEPT rather than removed. A supervisor reads it live, but
 * the harvester is pointed at a run directory that may have been written by any
 * earlier version of this CLI, and the runs whose env files still hold
 * credentials are exactly the ones written before credentials moved out of them.
 *
 * Bytes are taken EXACTLY as they sit on disk — no trim, no newline strip.
 * `writeWorkerSecretFiles` writes the raw value with no trailing newline
 * deliberately and then verifies the file's length equals the value's, so
 * trimming here would silently disagree with that guarantee for any credential
 * whose real value ends in whitespace.
 */
export async function resolveGrantedSecretValues(
  secretsDir: string,
  envFilePath: string,
  granted: readonly string[],
): Promise<ResolvedSecrets> {
  if (granted.length === 0) {
    return { values: new Map(), source: "none", unresolved: [] };
  }

  // THE STORE, one file per name.
  const fromStore = new Map<string, string>();
  for (const name of granted) {
    /*
     * The name is not sanitised here because it cannot be worker-authored: it
     * comes from the intersection of `secrets.env_allowlist` with the worker's
     * request, both operator-authored config validated at `up`. A traversal in
     * that string is an operator writing one into their own fleet.yaml.
     */
    const text = await readCapped(join(secretsDir, name), MAX_SECRET_READ_BYTES);
    if (text !== null) fromStore.set(name, text);
  }

  /*
   * PER-NAME, not all-or-nothing, and this was got wrong once already.
   *
   * The first version of this function took the store wholesale when the store
   * had anything in it, on the reasoning that a half-populated store is still
   * the current layout and falling back would "look like a fix while actually
   * reading pointers". That reasoning does not survive contact with what the
   * two files actually hold.
   *
   * They are not two layouts of the same set. The store holds the `secrets:`
   * GRANTS. The env file additionally holds fleet-set values that were never
   * grants. Taking the store wholesale therefore DROPPED the LLM key from
   * redaction: measured against the run that produced this module, where the
   * fixed redactor armed the two grants and reported `OMLX_API_KEY` unresolved
   * — a name the broken version had been scrubbing correctly.
   *
   * D8 MOVED THE LLM KEY ACROSS THAT LINE, and the sentence recording it is
   * corrected here rather than quietly dropped, because the correction is the
   * interesting part. This block used to say the provider key "has no file in
   * the store because it is not a `secrets:` entry" — true when the key was an
   * environment value, and false since `worker-env.ts` began writing it to
   * `<secretsDir>/<llm.api_key_env>` and pointing at it. So the key now
   * resolves on the STORE arm, not the fallback arm, and that is exactly why
   * the file is named for the operator's variable rather than for anything the
   * fleet chose: `SECRET_NAMES_VAR` arms this resolver with `llm.api_key_env`'s
   * spelling, and the store lookup is by that same name.
   *
   * The fallback is NOT thereby dead, and the code is unchanged. It still
   * carries every fleet-set variable that is redactable and has no file, and it
   * is what keeps a run recorded before D8 — or any future value delivered as a
   * variable — resolvable rather than silently unscrubbed.
   *
   * The pointer worry it was guarding against does not exist, because the
   * fallback looks up the BARE name and a pointer is only ever stored under
   * `<NAME>_FILE`. There is no lookup here that can return a path.
   *
   * So: each name takes its value from the store if it has one there, and from
   * the env file otherwise. `unresolved` then means what it says — no layout
   * had it — instead of meaning "the other layout had it and I did not look".
   */
  const envText = await readCapped(envFilePath, MAX_SECRET_READ_BYTES);
  const fromEnv = envText === null ? new Map<string, string>() : parseEnvFile(envText);

  const values = new Map<string, string>();
  const unresolved: string[] = [];
  let usedStore = false;
  let usedEnv = false;
  for (const name of granted) {
    const v = fromStore.get(name) ?? fromEnv.get(name);
    if (v === undefined || v.length < MIN_RESOLVED_LENGTH) {
      unresolved.push(name);
      continue;
    }
    if (fromStore.has(name)) usedStore = true;
    else usedEnv = true;
    values.set(name, v);
  }

  /*
   * The store WINS the label when both contributed, because the question the
   * label answers is "is this run on the current delivery layout" — and a run
   * whose grants come from files is, whatever else its env file also carries.
   */
  const source: SecretValueSource =
    values.size === 0 ? "none" : usedStore ? "store" : usedEnv ? "env-file" : "none";
  return { values, source, unresolved };
}
