/**
 * The credential sweep's NEEDLE SUPPLIER (ISC-333).
 *
 * ## The defect this closes, stated as what it cost
 *
 * `findCredentialLeaks` has had a production caller since ISC-332:
 * `parseTicketOpsArtifact` runs it over every `ticket-ops.json` the harvester
 * accepts, and a hit becomes a discrepancy and a `failed` ceiling exactly as a
 * schema violation does. What it did not have was anything to look FOR.
 * `HarvestOptions.secrets` was plumbed end to end and defaulted to `[]` at
 * every production call site, so the sweep ran over an empty needle set and
 * could not fire — a detector that cannot detect, which reads as coverage and
 * is worse than no detector at all. A worker echoed its own credential; the
 * value reached the outbox and the transcript; and this ran, found nothing, and
 * said so.
 *
 * ## WHERE THE NEEDLES COME FROM, and the two things they are not
 *
 * They are the values of the variables THIS worker was granted under
 * `secrets:` — nothing else on the machine.
 *
 * They are NOT a scan of the host environment. `process.env` in the harvester
 * holds the operator's whole shell: every cloud token, every API key for every
 * unrelated project. Sweeping with that would put all of it into the process
 * that renders the report, to catch a leak of the two variables one worker was
 * actually given. The blast radius of the fix would exceed the leak.
 *
 * They are NOT derived from config either. `harvest/patterns.ts` states the
 * rule — a harvester is handed a run directory, not a workspace, and a run
 * outlives the config that produced it — so the grant is read from what `up`
 * recorded in the run (`WorkerLaunch.secret_names`) and the values from the
 * per-worker secret store `up` wrote beside it. Both are per-worker, both are
 * inside the run directory, and neither depends on where or when the harvest
 * was typed.
 *
 * ## THE STORE MOVED ONCE, AND THAT IS WHY THIS READS TWO LAYOUTS
 *
 * When this module was written, `up` delivered granted secrets as environment
 * variables and the values were readable from the worker's 0600 `--env-file`.
 * ISC-337..342 moved delivery to one 0444 file per name under
 * `WorkerPaths.secretsDir`, so that a worker running `echo $TICKET_API_TOKEN`
 * gets an empty string. That change removes the values from the env file
 * entirely: it now carries `<NAME>_FILE=/secrets/<NAME>` and nothing else.
 *
 * A supplier that kept reading the env file would still find the granted NAME
 * absent from it, report every grant unresolved, and sweep with an empty needle
 * list — the detector back in the exact state ISC-333 was filed to end, wearing
 * the uniform of a security improvement. Worse, it would have failed QUIETLY in
 * both directions: the delivery change's own tests assert the value is NOT in
 * the env file, so they go green on the same fact that blinds the sweep.
 *
 * So the store is read first, and the env file is read only when there is no
 * store. That fallback is not politeness toward old code; it is the same rule
 * as the paragraph above. `pifleet report` is pointed at a run directory that
 * may have been written by any earlier version of this CLI, and the runs
 * carrying credentials in their env files are precisely the ones written before
 * the credentials moved out of them — including the run whose leak caused all
 * of this. A supplier that read only the new layout would go blind on exactly
 * the history worth sweeping.
 *
 * ## Why holding the values here is the right trade, said out loud
 *
 * ISC-333's entry asks for this to be justified rather than assumed, because
 * the harvester is the process that renders the report and putting plaintext
 * credentials in it is a real cost. Three things make the trade worth it.
 *
 * The scope is one worker's grant, read only when that worker HAS one — a
 * fleet with no `secrets:` anywhere never opens an env file at all, and the
 * common case is an empty array and no read.
 *
 * The values never leave. They are compared with `String.includes` and are
 * never interpolated into a finding: `parseTicketOpsArtifact` throws a message
 * naming PATHS, and `test/unit/harvest-credential-sweep-wiring.test.ts` asserts
 * the rendered harvest does not contain the needle. A sweep that quoted what it
 * found would spread the value one hop further, into the report — which is the
 * failure it exists to stop, wearing the uniform of the fix.
 *
 * And the alternative is not "no plaintext in the harvester". It is the value
 * sitting in `events.jsonl` and the session transcript with nothing having
 * noticed, which is where it went.
 */

import { open } from "node:fs/promises";
import { join } from "node:path";
import { readWorkerLaunch } from "../run/state.ts";
import type { WorkerPaths } from "../run/paths.ts";
import { safeForReport } from "./outbox.ts";

/**
 * The shortest value that may be used as a needle.
 *
 * A one-character needle matches every document, so every harvest would report
 * a leak and the finding would carry no information — the same "reporting
 * everything is reporting nothing" failure `findCredentialLeaks` already
 * guards against for the empty string, one step further along. Eight bytes is
 * chosen against what a granted variable legitimately holds rather than against
 * what a token looks like: `secrets:` carries the occasional short flag or
 * region name (`prod`, `us-east-1`, `true`), and those appear in honest prose
 * constantly. Every credential format this fleet actually delivers — an API
 * key, a bearer token, a personal access token — is far longer than this.
 *
 * The cost of the floor is stated rather than hidden: a genuine secret shorter
 * than eight bytes is not swept. That is a secret whose entropy is too low to
 * distinguish from an English word by literal matching at all, so the sweep
 * could not have graded it either way — it would have reported every harvest.
 */
export const MIN_NEEDLE_BYTES = 8;

/**
 * Bytes read from a worker's env file before the read is abandoned.
 *
 * The harvester's byte caps (`MAX_ARTIFACT_BYTES`, `MAX_RECONCILED_BYTES`)
 * bound what a WORKER can make the harvest read. This bounds a different
 * thing — a host file `up` wrote — and it still gets a cap, because a run
 * directory is on disk and a harvest must not become an unbounded read of
 * whatever is sitting at that path today. 64 KiB is two orders of magnitude
 * above any plausible env file (`buildWorkerEnv` writes tens of short lines).
 *
 * It deliberately does NOT draw from the reconciliation budget. That budget
 * meters what the OUTBOX costs the harvester, and spending it here would let a
 * worker's own artifacts push the needle read out of the way — turning "the
 * outbox was large" into "the sweep did not run", which is the suppression
 * `reconcile.ts` reordered its reverse-direction pass to close.
 */
export const MAX_ENV_FILE_BYTES = 64 * 1024;

/**
 * Bytes read from ONE file in a worker's secret store before the read is
 * abandoned.
 *
 * Two orders of magnitude smaller than the env-file cap, because the two caps
 * bound different things. The env file is a whole environment and its size is
 * a function of how many variables the fleet sets; a secret file holds ONE
 * value, `writeWorkerSecretFiles` asserts its length equals that value's, and
 * every credential format this fleet delivers is a few dozen bytes. 64 KiB is
 * far above any of them while staying far below "read whatever is at that path
 * today" — which matters more here than it did there, because this cap is
 * applied once PER GRANTED NAME rather than once per worker.
 *
 * A value longer than this is not truncated into a needle. A truncated needle
 * is worse than no needle: `String.includes` of a prefix matches documents the
 * full value does not appear in, so the sweep would start reporting leaks that
 * did not happen, on a run where the real one still would not be found.
 */
export const MAX_SECRET_FILE_BYTES = 64 * 1024;

/** What one worker's grant resolved to. */
export interface NeedleSupply {
  /**
   * The VALUES, for literal matching only.
   *
   * Never rendered, never logged, never put in a finding. Callers pass this
   * straight into the sweep and hold no other reference to it.
   */
  needles: string[];
  /**
   * The granted names that produced them — safe to print, by construction.
   *
   * Separated from the values for the reason `WorkerEnvPlan` separates them: a
   * diagnostic that wants to say what was swept can reach this field and
   * cannot reach the other one.
   */
  names: string[];
  /**
   * A degradation, or `null`. A grant that was recorded but could not be
   * resolved is worth saying — it means the sweep ran narrower than the run
   * intended, and silence there is the shape of the defect this file closes.
   */
  note: string | null;
}

const EMPTY: NeedleSupply = { needles: [], names: [], note: null };

/**
 * Read at most `cap` bytes of a file, or `null` if it is not there.
 *
 * A positional read into a fixed buffer rather than `readFile`, so the cap is
 * enforced by the syscall and not by checking a string's length after the whole
 * file is already in memory.
 */
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
 * `serializeEnvFile` writes `KEY=value` with no quoting and no escapes,
 * because `docker run --env-file` has none: it splits at the FIRST `=` and
 * takes the entire remainder verbatim. Reading it back with a parser that
 * strips quotes or honours backslashes would produce a needle that is not the
 * string in the container — and a needle one character off matches nothing,
 * which fails silently and in the direction that looks clean.
 */
function parseEnvFile(text: string): Map<string, string> {
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
 * Values for the granted names, read from the per-worker SECRET STORE — the
 * layout `up` writes today.
 *
 * Returns `null` when the store is not there at all, which is how the caller
 * distinguishes "this run predates file delivery" from "this run has a store
 * and some name in it is missing". Those two want different handling and
 * collapsing them would turn a real degradation into a silent fallback.
 *
 * The bytes are taken EXACTLY as they sit on disk — no trim, no newline strip.
 * `writeWorkerSecretFiles` writes the raw value with no trailing newline
 * deliberately (the documented `curl --config` line concatenates these bytes
 * into a quoted header) and verifies afterwards that the file's length equals
 * the value's. Trimming here would silently disagree with that guarantee for
 * any credential whose real value ends in whitespace, and a needle one
 * character off matches nothing — the same failure the env parser above
 * refuses, in the same direction that looks clean.
 */
async function valuesFromStore(
  wp: WorkerPaths,
  granted: readonly string[],
): Promise<Map<string, string> | null> {
  const found = new Map<string, string>();
  let any = false;
  for (const name of granted) {
    /*
     * `join` with the recorded name, and the name is not sanitised HERE
     * because it cannot be worker-authored: `secret_names` is copied from
     * `WorkerEnvPlan.secretNames`, which `buildWorkerEnv` builds from the
     * intersection of `secrets.env_allowlist` with the worker's request —
     * both operator-authored config, both validated at `up`. A traversal in
     * that string is an operator writing one into their own fleet.yaml.
     */
    const text = await readCapped(join(wp.secretsDir, name), MAX_SECRET_FILE_BYTES);
    if (text === null) continue;
    any = true;
    found.set(name, text);
  }
  /*
   * `any` and not `found.size > 0`: a store containing one empty file is still
   * a store, and reporting it as "no store, fall back to the env file" would
   * make an empty credential look like an old run directory. The env file it
   * fell back to would carry only `<NAME>_FILE` pointers, so the fallback
   * cannot succeed — it would just relabel the failure.
   */
  return any ? found : null;
}

/**
 * Resolve the needles for one worker: the grant `up` recorded, valued from the
 * per-worker secret store — or, for a run directory written before delivery
 * moved, from the 0600 env file.
 *
 * Never throws. A harvest is the fleet's account of what happened, and a run
 * directory missing a file it once had must still produce a report — the same
 * stance `validateTicketOps` takes about a document that will not parse. A
 * failure here degrades to "no needles", which is the behaviour the harvest
 * had before this module existed, plus a note saying so.
 *
 * Nothing is opened unless a grant was recorded. A fleet that hands out no
 * secrets performs no read at all, so the ordinary case costs one JSON parse
 * of a file `harvestTask` already reads.
 */
export async function resolveWorkerNeedles(wp: WorkerPaths): Promise<NeedleSupply> {
  const launch = await readWorkerLaunch(wp).catch(() => null);
  // `null` is the `PIFLEET_PI_COMMAND` double: no container was started, so
  // neither the store nor the env file was handed to anything and there is no
  // delivered credential for an artifact to be carrying. Not a degradation —
  // see `WorkerLaunchSchema.secret_names`.
  if (launch === null) return EMPTY;
  const granted = launch.secret_names;
  if (granted.length === 0) return EMPTY;

  /*
   * THE STORE FIRST, the env file only if there is no store.
   *
   * Not the other way round, and not "whichever has the value". Once delivery
   * moved, the env file for a current run carries `<NAME>_FILE=/secrets/<NAME>`
   * — a PATH under the granted name's pointer, never the value — so a reader
   * that consulted it first would find nothing under the bare name anyway. The
   * order is written down because the failure it prevents is the one that
   * looks fine: a future layout that puts something readable under the bare
   * name in the env file would start supplying that instead of the credential,
   * and the sweep would run on a needle that is not the secret.
   */
  const stored = await valuesFromStore(wp, granted);
  let vars: Map<string, string>;
  let source: "store" | "env file";
  if (stored !== null) {
    vars = stored;
    source = "store";
  } else {
    const text = await readCapped(wp.envFile, MAX_ENV_FILE_BYTES);
    if (text === null) {
      return {
        needles: [],
        names: [],
        note:
          `${granted.length} granted secret(s) could not be read back for the credential ` +
          `sweep: ${safeForReport(wp.workerId)} has neither a secret store nor a readable ` +
          `env file, so the sweep ran with no needles`,
      };
    }
    vars = parseEnvFile(text);
    source = "env file";
  }

  const needles: string[] = [];
  const names: string[] = [];
  const unresolved: string[] = [];
  for (const name of granted) {
    const value = vars.get(name);
    // Short and blank values are DROPPED rather than reported as unresolved:
    // the variable was delivered, it is simply not usable as a literal needle.
    // Counting it as a failure would put a permanent note on every run that
    // grants a region name.
    if (value === undefined) {
      unresolved.push(name);
      continue;
    }
    if (value.trim() === "" || value.length < MIN_NEEDLE_BYTES) continue;
    needles.push(value);
    names.push(name);
  }
  return {
    needles,
    names,
    note:
      unresolved.length === 0
        ? null
        : /*
           * ESCAPED, though this is control-plane text rather than worker
           * text. `launch.json` sits in the run directory, which no mount in
           * `container/mounts.ts` names, so a worker cannot author these
           * names — but this string is published into the harvest report, and
           * a run directory that has been hand-edited or moved between
           * machines is the case where a name carrying a newline would forge
           * a line in the report that is judging it (SRD 12.6). The same
           * treatment `reconcile.ts` gives every other name it prints.
           *
           * It NAMES THE SOURCE it read, because the two sources fail for
           * different reasons and the fix differs: a name missing from the
           * store is a file that did not land, while a name missing from an
           * env file is almost always a run whose secrets were delivered as
           * files after all. A note that said only "does not carry" would
           * send a reader to the wrong one.
           */
          `the run records secrets granted to ${safeForReport(wp.workerId)} that its ${source} ` +
          `does not carry (${safeForReport(unresolved.join(", "), 256)}); those were not swept for`,
  };
}
