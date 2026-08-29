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
 * 0600 env file `up` wrote beside it. Both are per-worker, both are inside the
 * run directory, and neither depends on where or when the harvest was typed.
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
 * Resolve the needles for one worker: the grant `up` recorded, valued from the
 * 0600 env file `up` wrote.
 *
 * Never throws. A harvest is the fleet's account of what happened, and a run
 * directory missing a file it once had must still produce a report — the same
 * stance `validateTicketOps` takes about a document that will not parse. A
 * failure here degrades to "no needles", which is the behaviour the harvest
 * had before this module existed, plus a note saying so.
 *
 * The env file is opened ONLY when a grant was recorded. A fleet that hands
 * out no secrets performs no read at all, so the ordinary case costs one JSON
 * parse of a file `harvestTask` already reads.
 */
export async function resolveWorkerNeedles(wp: WorkerPaths): Promise<NeedleSupply> {
  const launch = await readWorkerLaunch(wp).catch(() => null);
  // `null` is the `PIFLEET_PI_COMMAND` double: no container was started, so
  // the env file was never handed to anything and there is no delivered
  // credential for an artifact to be carrying. Not a degradation — see
  // `WorkerLaunchSchema.secret_names`.
  if (launch === null) return EMPTY;
  const granted = launch.secret_names;
  if (granted.length === 0) return EMPTY;

  let text: string;
  try {
    const handle = await open(wp.envFile, "r");
    try {
      const buf = Buffer.allocUnsafe(MAX_ENV_FILE_BYTES);
      const { bytesRead } = await handle.read(buf, 0, MAX_ENV_FILE_BYTES, 0);
      text = buf.subarray(0, bytesRead).toString("utf8");
    } finally {
      await handle.close();
    }
  } catch (e) {
    return {
      needles: [],
      names: [],
      // The errno name, never the whole error: `String(err)` carries host paths.
      note:
        `${granted.length} granted secret(s) could not be read back for the credential sweep ` +
        `(${(e as NodeJS.ErrnoException).code ?? "unknown"}); the sweep ran with no needles`,
    };
  }

  const vars = parseEnvFile(text);
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
           */
          `the run records secrets granted to ${safeForReport(wp.workerId)} that its env file ` +
          `does not carry (${safeForReport(unresolved.join(", "), 256)}); those were not swept for`,
  };
}
