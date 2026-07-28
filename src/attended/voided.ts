/**
 * The voided-requirements table (SRD §3.5, §16 Phase 6).
 *
 * Attended mode's honest failure is silent: the run still produces a result
 * envelope, a verdict and a diff, and none of them mean quite what they mean
 * unattended. This table is the difference, written down — the exact ISA
 * criteria that stop holding once a person types into a worker's pane, each
 * with one sentence an operator can act on.
 *
 * Two properties are load-bearing:
 *
 * 1. **Every `isc` here must name a criterion that exists in `ISA.md`.**
 *    A table naming a renumbered or deleted criterion is worse than no table,
 *    because it looks authoritative while pointing at nothing. The cross-check
 *    lives in `definedIscIds`/`unknownIscs` below and is enforced by
 *    `test/unit/voided.test.ts` against the real ISA file.
 *
 * 2. **The table is derived from reading the criteria, not from the SRD's
 *    §3.5 prose.** The SRD's tui design reparents Pi's stdin to the pane; this
 *    implementation does not — the supervisor keeps the RPC stream, so RPC
 *    `abort`, stats polling and dialog answering all still work. What a person
 *    in the pane gets is hands inside the worker's container and worktree, and
 *    the guarantees that die are the ones about ATTRIBUTION and QUIESCENCE:
 *    everything that treats the diff as the agent's work, the settle as the
 *    end of writes, and the pane as a surface that carries no input.
 */

import { VoidedRequirementSchema, type VoidedRequirement } from "../contracts.ts";

/**
 * What stops holding in `tui` mode. Order follows ISC number so a reader can
 * diff this against the ISA top to bottom.
 *
 * Parsed through the schema at module load so a malformed entry — a typo'd id
 * that the ISA cross-check would wave through because the regex never matched
 * it as an id at all — fails the first import, not the first report.
 */
export const TUI_VOIDED: readonly VoidedRequirement[] = [
  {
    isc: "ISC-84",
    because:
      "Human edits carry no epoch marker, so changes made during epoch N surface in whichever diff is cut next; per-epoch attribution is unreliable for the rest of the run.",
  },
  {
    isc: "ISC-87",
    because:
      "Settle now proves only that the agent went quiet; a person can keep changing the worktree after the task reports complete, so treat the verdict as a snapshot, not a close.",
  },
  {
    isc: "ISC-92",
    because:
      "Claim-versus-diff flagging assumes one author; a person reverting or finishing the worker's files makes the flag fire on honest claims and stay silent on false ones.",
  },
  {
    isc: "ISC-93",
    because:
      "A person's edits can supply the non-empty diff that lets a do-nothing worker's success claim stand; corroborate the verdict against the transcript by hand.",
  },
  {
    isc: "ISC-94",
    because:
      "Verdict reconstruction adopts whatever evidence the tree shows, so a clean diff and green acceptance may certify work the person did, not the worker.",
  },
  {
    isc: "ISC-106",
    because:
      "The pane's shell inherits the image PATH, so a person's gcloud/kubectl/helm/gsutil/bq calls pass through the same verbgate and land in the ledger in the agent's row shape with no author and no task id; the mutating-verb audit trail no longer distinguishes who acted.",
  },
  {
    isc: "ISC-107",
    because:
      "Every cloud invocation is still recorded, but the ledger stops being a record of what the AGENT did — read it as what someone did from this worker.",
  },
  {
    isc: "ISC-141",
    because:
      "Stream-offset fencing orders RPC records only; a person's writes have no stream position at all, so the fence cannot place their work before or after any epoch.",
  },
].map((v) => VoidedRequirementSchema.parse(v));

/**
 * The set of criterion ids the ISA actually DEFINES.
 *
 * Matches only the checkbox definition shape (`- [ ] ISC-87: …` /
 * `- [x] ISC-248a: …`), never a bare mention in prose — the ISA discusses
 * criteria by id all over its Decisions and Verification sections, and a
 * mention is not a definition. A voided entry pointing at an id that is only
 * ever mentioned would be exactly the rot this check exists to catch.
 */
export function definedIscIds(isaText: string): Set<string> {
  const ids = new Set<string>();
  const re = /^- \[[ x]\] (ISC-\d+[a-z]?):/gm;
  for (const m of isaText.matchAll(re)) ids.add(m[1]!);
  return ids;
}

/**
 * Every `isc` in `table` that `defined` does not contain, in table order.
 * Empty array means the table is safe to show an operator.
 */
export function unknownIscs(
  table: readonly VoidedRequirement[],
  defined: ReadonlySet<string>,
): string[] {
  return table.map((v) => v.isc).filter((id) => !defined.has(id));
}
