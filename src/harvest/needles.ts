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

import { readWorkerLaunch } from "../run/state.ts";
import { resolveGrantedSecretValues } from "../security/secret-values.ts";
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
 * Resolve the needles for one worker: the grant `up` recorded, valued through
 * the SHARED resolver in `security/secret-values.ts`.
 *
 * The lookup is not implemented here, and that is the point of ISC-345 rather
 * than a style preference. This module and the event-log redactor both need
 * the values of one worker's granted secrets; they were written separately,
 * each with its own env-file parser, and when delivery moved to files BOTH
 * went blind while each one's own tests stayed green. This one was fixed in
 * place; the other was not found until a live worker put a real credential
 * into an event log. One resolver means the next delivery change has one call
 * site to follow instead of a set someone has to remember correctly.
 *
 * Never throws. A harvest is the fleet's account of what happened, and a run
 * directory missing a file it once had must still produce a report — the same
 * stance `validateTicketOps` takes about a document that will not parse. A
 * failure degrades to "no needles", which is the behaviour the harvest had
 * before this module existed, plus a note saying so.
 *
 * Nothing is opened unless a grant was recorded, so a fleet that hands out no
 * secrets costs one JSON parse of a file `harvestTask` already reads.
 */
export async function resolveWorkerNeedles(wp: WorkerPaths): Promise<NeedleSupply> {
  const launch = await readWorkerLaunch(wp).catch(() => null);
  // `null` is the `PIFLEET_PI_COMMAND` double: no container was started, so
  // nothing was handed a credential and there is none for an artifact to be
  // carrying. Not a degradation — see `WorkerLaunchSchema.secret_names`.
  if (launch === null) return EMPTY;
  const granted = launch.secret_names;
  if (granted.length === 0) return EMPTY;

  const resolved = await resolveGrantedSecretValues(wp.secretsDir, wp.envFile, granted);

  const needles: string[] = [];
  const names: string[] = [];
  for (const [name, value] of resolved.values) {
    // Short and blank values are DROPPED rather than reported: the variable was
    // delivered, it is simply not usable as a literal needle. Counting it as a
    // failure would put a permanent note on every run that grants a region
    // name. This floor is the SWEEP's, deliberately kept here rather than
    // pushed into the shared resolver — the redactor's floor is a different
    // number chosen against a different failure.
    if (value.trim() === "" || value.length < MIN_NEEDLE_BYTES) continue;
    needles.push(value);
    names.push(name);
  }

  return {
    needles,
    names,
    note:
      resolved.unresolved.length === 0
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
          `the run records secrets granted to ${safeForReport(wp.workerId)} that neither its ` +
          `secret store nor its env file carries ` +
          `(${safeForReport(resolved.unresolved.join(", "), 256)}); those were not swept for`,
  };
}
