/**
 * What leaves the machine, named before anything is created (SRD §7.3, D10).
 *
 * ## Why this module exists at all, and why it is not two functions
 *
 * D10 reversed a refusal. The draft SRD proposed that `up` REFUSE a worker
 * resolving to a `hosted: true` provider while holding `cloud_access: true` or
 * a non-empty `secrets:`; the owner ruled against it. Every role stays
 * eligible, `observer` and `ticketing` included, and **the control is
 * prominence rather than prevention** — §7.2's words. So a credentialled
 * worker on a hosted provider now stands up, and the only thing standing
 * between the operator and a surprise is the line this module produces.
 *
 * That makes the derivation load-bearing in a way a formatting helper is not.
 * §7.3 asks for the disclosure on TWO surfaces — `up` prints it before it
 * creates anything, and the same facts are written into the run's launch
 * record so a harvested run can be asked the question afterwards. ISC-417
 * asserts those two name the SAME SET, with a mismatch failing in either
 * direction.
 *
 * **A criterion of that shape is a coin flip the moment two places decide the
 * fact.** This branch has already shipped four defects from exactly that —
 * the `/secrets` mount, the worker's network, the relay's target name and the
 * provider's credential each got decided twice and the two copies drifted. So
 * there is one function here, it answers for ONE worker, and both surfaces
 * call it. The banner maps it over the run's ids and filters the nulls; the
 * launch record calls it inside the per-worker loop it already has.
 *
 * ## Why per-worker rather than a fleet-wide list
 *
 * A `disclosureRows(loaded)` returning the whole fleet reads better at the
 * banner and is wrong at the other end: the record writer would have to
 * re-filter the list down to the worker it is writing, and that filter is a
 * SECOND predicate answering "does this worker's context leave the machine".
 * Two predicates, one question — the shape above. `null` is the answer for a
 * worker whose context stays put, and the record writer skips the field on a
 * `null` exactly as the banner skips the line.
 *
 * ## `repo` is the CONFIGURED path, never a resolved worktree
 *
 * The two callers run at different times and know different things. The
 * banner runs before `up` has created a single directory; the record write
 * runs after `materializeWorkerInputs` has a real per-worker clone path in
 * hand. If this field meant "the worktree", the two consumers could not agree
 * — not through carelessness but because the worktree does not exist yet when
 * the banner prints, and ISC-417 would fail on a difference neither side got
 * wrong. `run.repo` is computable from `loaded` alone at both call times, so
 * it is one derivation; and it is also the more honest answer, because the
 * clone is a copy of that repository and it is that repository's source that
 * reaches the vendor.
 *
 * ## NAMES ONLY, NEVER VALUES
 *
 * `secretNames` carries variable NAMES. The launch record's `secret_names`
 * field exists in precisely this shape because it is, in `worker-env.ts`'s
 * words, *"structurally incapable of putting a credential in front of"* its
 * readers. This row has the same obligation and a WIDER audience: the record
 * is a file, the banner goes to a terminal and from there into scrollback, a
 * screen share and a support paste. A `string[]` of names cannot carry a
 * value, and that is why the type is what it is rather than a convenience.
 */

import { expandPath, providerIsHosted, type LoadedConfig, type ResolvedWorker } from "../config/load.ts";
import type { Isolation } from "../config/schema.ts";

/**
 * One worker whose context will leave this machine.
 *
 * Every field is one §7.3 asks for by name: *"the worker id, the role, the
 * provider, the isolation mode and the repository path if it has one, and —
 * the part D10 makes load-bearing — whether it holds `cloud_access` and which
 * `secrets:` names it was granted."* The last two are the ones D10 promoted:
 * before the reversal they described a configuration the fleet refused, so
 * they had no reason to be on a line about what is permitted.
 */
export interface DisclosureRow {
  readonly workerId: string;
  readonly role: string;
  /** The `llm.providers` key this worker resolved to. Always `hosted: true`. */
  readonly provider: string;
  readonly isolation: Isolation;
  /**
   * The CONFIGURED repository (`run.repo`, absolute), or `null` for
   * `isolation: none` — the one mode with no `/workspace` to send.
   *
   * Not the worktree. See the module docblock: the worktree is a fact only
   * one of this row's two consumers can know.
   */
  readonly repo: string | null;
  readonly cloudAccess: boolean;
  /**
   * The `secrets:` names this worker was granted, in request order, deduped.
   *
   * NAMES. Never values — see the module docblock.
   */
  readonly secretNames: string[];
}

/**
 * The disclosure row for one worker, or `null` if its context stays here.
 *
 * ## Why a host environment is not a parameter, and why that is proven
 *
 * The obvious worry about deriving granted secret names from config alone is
 * that `buildWorkerEnv` is the real grant authority and this would be a second
 * opinion of it. It is not, and the reason is structural rather than a
 * promise: **every path in that function's grant loop that would EXCLUDE a
 * requested name throws instead of skipping it.** An unallowlisted name raises
 * `SecretNotAllowlistedError`, a reserved one `SecretReservedNameError`, a
 * colliding pointer `SecretPointerCollisionError`, and one the host does not
 * carry is collected and raised as `SecretMissingFromHostError`. The single
 * `continue` in the loop is the dedupe. So the granted list is the deduped
 * request list, and any `up` that gets far enough to print a banner has
 * already had that proven for it by `assertSecretsResolvable`.
 *
 * That equality is what lets the banner print BEFORE anything is created,
 * which §7.3 requires and which is the whole difference between a disclosure
 * and a receipt. It is also exactly the kind of reasoning that rots quietly,
 * so it is pinned by a test that runs this against `buildWorkerEnv` and
 * compares — if someone later turns one of those throws into a `continue`,
 * the equality fails loudly here rather than by this banner overstating a
 * grant.
 *
 * ## A flat fleet can never produce a row
 *
 * §6.1 keeps the flat `llm.*` keys as the default provider's shorthand, and
 * that shorthand has no `hosted` field to set — `ProviderSchema` is where the
 * flag lives and it is REQUIRED there (D3, never inferred). So a pre-D7
 * `fleet.yaml` returns `null` for every worker and prints nothing new, which
 * is the correct answer rather than a grandfather clause: a flat fleet is
 * oMLX on the operator's own machine and nothing leaves it.
 */
export function disclosureFor(loaded: LoadedConfig, w: ResolvedWorker): DisclosureRow | null {
  if (!providerIsHosted(loaded.config, w.provider)) return null;
  /*
   * `isolation: none` is the only mode with no `/workspace`, and
   * `worker-env.ts` draws the line in exactly this place — its `safe.directory`
   * block is guarded by `w.isolation !== "none"` for the same reason. Read the
   * same way here so the banner cannot claim a repository the container has no
   * mount for.
   */
  const repo = w.isolation === "none" ? null : expandPath(loaded.config.run.repo, loaded.dir);
  /*
   * Deduped first-occurrence-wins, matching `buildWorkerEnv`'s
   * `if (secretNames.includes(requested)) continue`. `secrets: [X, X]` is a
   * typo with one obvious meaning and there is no second value for the two
   * entries to disagree about — but a banner that printed `X, X` would invite
   * the reader to think two things were granted.
   */
  const secretNames: string[] = [];
  for (const name of w.secrets) {
    if (!secretNames.includes(name)) secretNames.push(name);
  }
  return {
    workerId: w.id,
    role: w.role,
    provider: w.provider,
    isolation: w.isolation,
    repo,
    cloudAccess: w.cloudAccess,
    secretNames,
  };
}

/** A row that also holds a credential — §7.4's revisit case, made loud. */
export function rowIsCredentialled(row: DisclosureRow): boolean {
  return row.cloudAccess || row.secretNames.length > 0;
}

/**
 * The banner, or `null` when nothing leaves the machine.
 *
 * `null` rather than an empty string, and the distinction is not stylistic:
 * "no worker sends anything to a vendor" must print NOTHING. §7.4 names the
 * failure mode directly — *"if an operator stops reading the banner because it
 * prints on every `up`, the reversal has stopped being a loud grant and become
 * a silent one"*. A banner that appears on every run, usually saying nothing
 * happened, is how that habit forms. This one appears only when there is
 * something to disclose.
 *
 * ## The credentialled line is marked, because §7.3 says it must be the loudest
 *
 * *"A credentialled worker on a hosted provider should be the most conspicuous
 * line `up` prints, because it is now permitted and nothing else stops it."*
 * `!!` carries that, and the trailing note says what the marker means so the
 * operator does not have to have read the SRD to read the banner.
 */
export function formatDisclosureBanner(rows: readonly DisclosureRow[]): string | null {
  if (rows.length === 0) return null;
  const rule = "=".repeat(78);
  const out: string[] = [
    rule,
    `DISCLOSURE: ${rows.length} worker(s) will send their context to a hosted provider.`,
    "  Nothing below is refused (SRD D10). This banner is the whole of the control.",
    "",
  ];
  for (const row of rows) {
    const mark = rowIsCredentialled(row) ? "!!" : "  ";
    out.push(
      `${mark} ${row.workerId}  role=${row.role}  provider=${row.provider}  ` +
        `isolation=${row.isolation}  repo=${row.repo ?? "(none)"}`,
    );
    out.push(
      `     cloud_access=${row.cloudAccess}  ` +
        // NAMES. The join is over a `string[]` that cannot hold a value.
        `secrets=${row.secretNames.length === 0 ? "(none)" : row.secretNames.join(",")}`,
    );
  }
  if (rows.some(rowIsCredentialled)) {
    out.push("");
    out.push("  !! holds a credential AND sends context to a vendor — SRD §7.4's watch case.");
  }
  out.push(rule);
  out.push("");
  return out.join("\n");
}
