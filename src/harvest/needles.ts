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
import { secretLines } from "../security/secret-lines.ts";
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

/** Whether a string may be a literal needle at all: not blank, and over the floor. */
function usableNeedle(s: string): boolean {
  return s.trim() !== "" && s.length >= MIN_NEEDLE_BYTES;
}

/**
 * The needles ONE value contributes: the whole value, and for a value that
 * spans lines, each line that is secret material.
 *
 * ## Why a multi-line value needs more than one needle
 *
 * `findCredentialLeaks` matches with `String.includes`, so the whole value only
 * catches an artifact that quotes ALL of it. A multi-line credential, such as
 * the observer roles' OpenSSH key (`multiline: true` in `config/schema.ts`),
 * leaks just as badly one line at a time, and a worker pasting "the first few
 * lines of the key" is the realistic shape of that leak. So each line is a
 * needle too, under the same floor.
 *
 * ## Which lines are NOT needles, and why that matters as much
 *
 * Blank lines, and PEM armor lines. Armor is public text that appears in every
 * key of a type and in honest prose about keys. Making it a needle would refuse
 * every artifact that says "the host rejected a BEGIN OPENSSH PRIVATE KEY
 * block", which is the false positive `credential: false` was written to end.
 *
 * ## Where the line rules live
 *
 * In `security/secret-lines.ts`, shared with the event-log redactor, which
 * needs the same answer for the same values. That module trims each line, and
 * it documents the one non-secret line it keeps on purpose (an OpenSSH key's
 * first body line). The floor passed in is THIS module's `MIN_NEEDLE_BYTES`,
 * never the redactor's. A value with no LF yields no lines, so a single-line
 * value is exactly the one needle it always was.
 */
function needlesFor(value: string): string[] {
  if (!usableNeedle(value)) return [];
  return [value, ...secretLines(value, MIN_NEEDLE_BYTES)];
}

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
   * The names that produced them — safe to print, by construction.
   *
   * Separated from the values for the reason `WorkerEnvPlan` separates them: a
   * diagnostic that wants to say what was swept can reach this field and
   * cannot reach the other one.
   *
   * ## THIS IS A SWEEP MANIFEST, NOT A GRANT LIST, and under D15 the two
   * ## stopped coinciding
   *
   * It used to say "the granted names", and that was accurate only while every
   * needle came from `launch.secret_names`. ISC-421 adds a second source — the
   * Class 1 provider key of a `hosted: true` worker — and the field's JOB is
   * "what was swept", so the key's name is ON this list. That was a real
   * judgement call and the reasoning is recorded rather than assumed.
   *
   * **Why it belongs here.** The failure this repo keeps paying for is a
   * component that reports itself doing something it is not doing:
   * `SECRET_NAMES_VAR`'s docstring predicted a redactor that "reports itself as
   * armed while scrubbing nothing", and it came true. Omitting the key inverts
   * the same defect — the sweep would scrub a value and report it had not — and
   * a manifest that does not describe the run is the same lie with the sign
   * flipped. It is not academic: `findCredentialLeaks`' finding names PATHS
   * only, deliberately, so a value is never quoted into a report. This list is
   * therefore the only surface that can tell an operator WHICH credential hit,
   * and the one credential every worker carries would be the one it could not
   * name.
   *
   * **What it risks, and why that risk is bounded structurally.** The grant
   * distinction this whole design preserves is that `launch.secret_names` must
   * never claim the key (ISC-422). Nothing here weakens it: that field is a
   * different surface, on a different record, written by a different process,
   * and it is untouched. This one is harvest-local, is never written back to
   * the run, and has exactly one kind of consumer — a diagnostic printing what
   * was swept. The dataflow is one-way and dies with the report, so a reader
   * who confuses the two has to ignore both names and both docblocks to do it.
   *
   * ## INDEX-ALIGNED with `needles`, so a name may repeat
   *
   * `names[i]` is the variable that produced `needles[i]`. A multi-line
   * credential contributes its whole value AND each secret line (see
   * `needlesFor`), so its name appears once per needle. That keeps the one
   * question this list answers honest for every needle: which grant does a hit
   * on this string belong to.
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
  /**
   * The Class 1 provider key's NAME, for a `hosted: true` worker (ISC-421).
   *
   * ## The gap, and why the guard below reads TWO fields now
   *
   * Everything above this function is about the values the fleet delivered as
   * GRANTS, and the Class 1 key is deliberately not one — `worker-env.ts`
   * refuses to widen `secretNames` to cover it, and ISC-422 stands guard on
   * that refusal. The consequence, measured rather than suspected, is that the
   * key's value was never a needle: the log redactor was armed for it and this
   * sweep was blind to it, for every fleet, on every run.
   *
   * **The guard this replaced would have made the whole change vacuous.** It
   * read `if (granted.length === 0) return EMPTY`, and a worker whose only
   * credential is the provider key has `secret_names: []` — that is precisely
   * what ISC-422 asserts, and it is the COMMON case, since a fleet with no
   * `secrets:` block anywhere still hands every worker a key. So the record
   * could carry a perfectly correct `provider_key_name` and the sweep would
   * still return `EMPTY` for exactly the fleet the criterion is about. The
   * fixture that hides this is the natural one: give the worker a grant AS WELL
   * and `granted.length` is non-zero, the early return is skipped, and
   * everything appears to work.
   *
   * ## The cheap-EMPTY promise is KEPT, and it is load-bearing
   *
   * This file's own argument for holding plaintext at all is that "the scope is
   * one worker's grant, read only when that worker HAS one — a fleet with no
   * `secrets:` anywhere never opens an env file at all". The guard is widened
   * by exactly one disjunct, not removed: a worker with no grant AND no hosted
   * provider key — every local-provider fleet, every keyless run, every record
   * written before D7 — still returns without opening anything. What changes is
   * that a HOSTED worker now resolves one value it did not before, which is the
   * blast radius D15 chose knowingly and priced as "one more chance of a false
   * positive".
   */
  const providerKeyName = launch.provider_key_name;
  if (granted.length === 0 && providerKeyName === null) return EMPTY;

  /**
   * The grants the fleet said are NOT credentials — delivered, not swept.
   *
   * ## The defect this closes, and it is the detector's opposite failure
   *
   * `secrets:` is the only per-worker delivery channel that exists, so a
   * variable that must reach a worker is listed there whether or not it is
   * secret. `TICKET_BASE_URL` is the standing case: a public endpoint, over
   * the eight-byte floor, and present in EVERY command a ticket worker
   * legitimately records. So `parseTicketOpsArtifact` refused every
   * `ticket-ops.json` as carrying a credential, every one became a
   * discrepancy, and every verdict clamped.
   *
   * ISC-333 was filed because this sweep could not fire. A sweep that fires on
   * every honest run is the same defect with one sign flipped: both produce a
   * finding that carries no information, and this one additionally trains an
   * operator to disbelieve the detector that catches the real leak.
   *
   * ## Read from the RUN, and that is not a detail
   *
   * `launch.non_credential_secrets`, not `fleet.yaml`. The paragraph at the
   * top of this file about where grants come from applies unchanged and for
   * the same reason: a run outlives its config. Reading the declaration from
   * whatever document happens to be in front of the harvester would sweep an
   * old run against a newer answer, in a direction nothing would notice.
   *
   * ## It narrows the sweep, so it is bounded twice
   *
   * The excluded name is INTERSECTED with the grant rather than trusted — a
   * record naming something this worker never held changes nothing — and the
   * exclusion is reported in `names` by its absence, so a caller that prints
   * what was swept prints the truth. `credential: true` is the default and a
   * bare string means it, so a new grant is swept unless someone deliberately
   * says otherwise.
   */
  const notCredentials = new Set(launch.non_credential_secrets);

  const resolved = await resolveGrantedSecretValues(wp.secretsDir, wp.envFile, granted);

  const needles: string[] = [];
  const names: string[] = [];
  for (const [name, value] of resolved.values) {
    // Declared not a credential: delivered to the worker, and deliberately not
    // a needle. Skipped BEFORE the length floor so the two reasons a value is
    // dropped stay distinguishable to anyone reading this loop.
    if (notCredentials.has(name)) continue;
    // Short and blank values are DROPPED rather than reported: the variable was
    // delivered, it is simply not usable as a literal needle. Counting it as a
    // failure would put a permanent note on every run that grants a region
    // name. This floor is the SWEEP's, deliberately kept here rather than
    // pushed into the shared resolver — the redactor's floor is a different
    // number chosen against a different failure. `needlesFor` applies it, to
    // the whole value and to each line of a multi-line one.
    for (const needle of needlesFor(value)) {
      needles.push(needle);
      names.push(name);
    }
  }

  /**
   * THE CLASS 1 KEY, swept through the SAME resolver and on its own arm.
   *
   * ## Why a second call rather than one widened list
   *
   * Appending the name to `granted` and resolving once would be shorter and is
   * refused for two reasons, both about honesty rather than style.
   *
   * The first is the note. `resolveGrantedSecretValues` returns `unresolved`,
   * and the note below says "the run records secrets GRANTED to this worker
   * that neither store nor env file carries". The key was not granted — that is
   * the entire distinction this feature preserves — so a merged list would make
   * the harvester's own diagnostic claim the grant that `secret_names` was kept
   * clean to avoid claiming. It gets its own sentence, which also happens to be
   * the more useful one: a missing provider key file means something different
   * from a missing grant file.
   *
   * The second is blast radius. The grant path above is byte-for-byte what it
   * was, so ISC-333, ISC-343 and the `credential: false` narrowing cannot
   * regress through this change — they run over the same list, in the same
   * order, from the same call. The new behaviour is purely additive and can be
   * deleted by deleting this block.
   *
   * It is the same FUNCTION either way, which is what ISC-345 actually asks
   * for: one place that knows where a value lives. Two calls to one resolver
   * is not the duplication that cost a live credential; two parsers was.
   *
   * ## `non_credential_secrets` is not consulted, and that is not an omission
   *
   * That list is the subset of the GRANT the fleet declared `credential: false`
   * — `worker-env.ts` computes it as `secretNames.filter(...)`, and the key can
   * never be in `secrets.env_allowlist` because `buildWorkerEnv` puts
   * `apiKeyEnvName` in its `reserved` set and throws on a worker that requests
   * it. So the filter could only ever be a no-op here, and running it anyway
   * would advertise an exception mechanism that cannot be reached. If a hosted
   * key ever does collide with honest artifact prose, D15 says the exception is
   * declared where the others are, not invented here.
   */
  const notes: string[] = [];
  if (providerKeyName !== null && !granted.includes(providerKeyName)) {
    const key = await resolveGrantedSecretValues(wp.secretsDir, wp.envFile, [providerKeyName]);
    const value = key.values.get(providerKeyName);
    if (value === undefined) {
      /*
       * A DEGRADATION worth its own sentence. `provider_key_name` is only
       * written by the statement that writes the key's file, so an unresolvable
       * name means the store was moved, pruned or hand-edited after the run —
       * and the sweep is running narrower than the run intended, which is the
       * silence this whole module exists to end.
       */
      notes.push(
        `the run records a hosted provider's API key for ${safeForReport(wp.workerId)} ` +
          `(${safeForReport(providerKeyName)}) that neither its secret store nor its env file ` +
          `carries; its value was not swept for`,
      );
    } else {
      // The same floor the grants get, applied for the same reason and not
      // reported for the same reason: a value below it is delivered, simply not
      // usable as a literal needle. A provider key short enough to trip this is
      // not a credential any vendor issues. Through `needlesFor` like the
      // grants, so the two arms cannot drift; a single-line key yields exactly
      // the one needle it always did.
      for (const needle of needlesFor(value)) {
        needles.push(needle);
        names.push(providerKeyName);
      }
    }
  }
  if (resolved.unresolved.length > 0) {
    notes.push(
      /*
       * ESCAPED, though this is control-plane text rather than worker text.
       * `launch.json` sits in the run directory, which no mount in
       * `container/mounts.ts` names, so a worker cannot author these names —
       * but this string is published into the harvest report, and a run
       * directory that has been hand-edited or moved between machines is the
       * case where a name carrying a newline would forge a line in the report
       * that is judging it (SRD 12.6). The same treatment `reconcile.ts` gives
       * every other name it prints. The provider-key note above is escaped for
       * the identical reason.
       */
      `the run records secrets granted to ${safeForReport(wp.workerId)} that neither its ` +
        `secret store nor its env file carries ` +
        `(${safeForReport(resolved.unresolved.join(", "), 256)}); those were not swept for`,
    );
  }

  return {
    needles,
    names,
    /*
     * JOINED rather than first-wins. Both degradations are "the sweep ran
     * narrower than the run intended", and reporting one while swallowing the
     * other is the shape of silence this module was filed over. `null` stays
     * the encoding for "nothing degraded", because `harvest/index.ts` pushes
     * this straight onto `reasons` and an empty string there would be a blank
     * line in the report.
     */
    note: notes.length === 0 ? null : notes.join("; also, "),
  };
}
