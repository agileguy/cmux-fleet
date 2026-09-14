/**
 * The two observer TARGET artifacts, as contracts the harvest validates
 * (SRD-OBSERVER-ROLES §5.6, §6.7, Phase 2).
 *
 * `observer-docker` writes `observer-docker-ops.json` and `observer-vm` writes
 * `observer-vm-ops.json`. `reconcile.ts` selects each by its file NAME, parses
 * it through the entry point below, and clamps the task to `failed` when the
 * parse refuses. That is the rule `ticket-ops.json` already runs under, for the
 * reasons `TICKET_OPS_ARTIFACT_NAME` gives.
 *
 * ## Same fields as `observer-ops.json`, and a declared kind on top
 *
 * Both documents keep the document fields and row gate fields the k8s
 * observer's document carries (`skills/observer-ops/SKILL.md`). So `assessment`,
 * `coverage[].result` and the four evidence fields mean the same thing in all
 * three roles. What each adds is a `schema` literal. The name SELECTS the
 * document and the literal CONFIRMS it, so a file at the right name that lost
 * its declaration is a schema failure rather than a skip.
 *
 * `coverage[].channel` is the one field closed differently per target, because
 * the channels are what a target can actually be asked. A docker host has no
 * systemd units and a VM has no container health check.
 *
 * ## Why the enums live here and not in the triage console
 *
 * The triage console defines the k8s observer's vocabulary. Importing it would
 * give the harvest a dependency on the console, and the SRD rules that out. The
 * four-member enums are short, so they are spelled here.
 *
 * ## No filesystem API, on purpose
 *
 * `reconcile.ts` argues it cannot dereference a worker-authored path because
 * nothing in its import graph opens a file. This module joins that graph, so it
 * imports only zod and the pure contracts module.
 */

import { z } from "zod";
import { MAX_ITEMS, MAX_SHORT, findCredentialLeaks, workerId } from "../contracts.ts";

/** The same bound `contracts.ts` puts on a short field of `TicketOpsArtifactSchema`. */
const shortStr = z.string().max(MAX_SHORT);

/**
 * A service's health, as the observer graded it. The closed four-member enum
 * of `skills/observer-ops/SKILL.md`. `failed` is a TASK status and is refused
 * here, because a fifth token is exactly the mistake that skill measured.
 */
export const ObserverAssessmentSchema = z.enum(["healthy", "degraded", "unhealthy", "indeterminate"]);

/** What asking one channel produced. The closed four-member enum of the same skill. */
export const ObserverCoverageResultSchema = z.enum([
  "answered",
  "unreachable",
  "forbidden",
  "not_attempted",
]);

/** What a docker observer can ask of a container (§5.6). */
export const ObserverDockerChannelSchema = z.enum(["state", "health", "logs", "stats", "events"]);

/** What a VM observer can ask of a VM (§6.7). */
export const ObserverVmChannelSchema = z.enum([
  "reachability",
  "system",
  "units",
  "logs",
  "resources",
  "cloud",
]);

/**
 * The row fields every observer target shares, less `coverage`, whose channel
 * enum is the per-target part.
 *
 * One object spread into both rows, so the two documents cannot drift apart on
 * the fields the SRD says they share.
 */
const sharedRowFields = {
  name: shortStr,
  /** The TARGET TOKEN: the named scope the service lives in on this target. */
  namespace: shortStr,
  assessment: ObserverAssessmentSchema,
  selector: shortStr,
  window: shortStr,
  evidence_ref: z.array(shortStr).max(MAX_ITEMS),
};

/**
 * The document fields every observer target shares, less `schema` and
 * `services`.
 *
 * `sweep_id` and `window_opened_at` are REQUIRED KEYS whose value may be
 * `null`. A missing key is refused. The skill treats a missing `sweep_id` as a
 * reason to discard the whole artifact, so an absent key must not read as a
 * deliberate `null`.
 */
const sharedDocumentFields = {
  worker: workerId,
  sweep_id: shortStr.nullable(),
  window_opened_at: shortStr.nullable(),
};

/** The file `observer-docker` writes to `/outbox/<task-id>/files/`. */
export const OBSERVER_DOCKER_OPS_ARTIFACT_NAME = "observer-docker-ops.json";

/** §5.6's document. One row is one container. */
export const ObserverDockerOpsArtifactSchema = z.object({
  schema: z.literal("pifleet.observer-docker-ops/v1"),
  ...sharedDocumentFields,
  services: z
    .array(
      z.object({
        ...sharedRowFields,
        coverage: z
          .array(z.object({ channel: ObserverDockerChannelSchema, result: ObserverCoverageResultSchema }))
          .max(MAX_ITEMS),
        container_id: shortStr.optional(),
        image: shortStr.optional(),
        restart_count: z.number().int().nonnegative().optional(),
      }),
    )
    .max(MAX_ITEMS),
});
export type ObserverDockerOpsArtifact = z.infer<typeof ObserverDockerOpsArtifactSchema>;

/** The file `observer-vm` writes to `/outbox/<task-id>/files/`. */
export const OBSERVER_VM_OPS_ARTIFACT_NAME = "observer-vm-ops.json";

/** §6.7's document. One row is one VM. */
export const ObserverVmOpsArtifactSchema = z.object({
  schema: z.literal("pifleet.observer-vm-ops/v1"),
  ...sharedDocumentFields,
  services: z
    .array(
      z.object({
        ...sharedRowFields,
        coverage: z
          .array(z.object({ channel: ObserverVmChannelSchema, result: ObserverCoverageResultSchema }))
          .max(MAX_ITEMS),
        uptime_s: z.number().nonnegative().optional(),
        system_state: shortStr.optional(),
        /** Unit names from `failed` output, quoted verbatim. */
        failed_units: z.array(shortStr).max(MAX_ITEMS).optional(),
      }),
    )
    .max(MAX_ITEMS),
});
export type ObserverVmOpsArtifact = z.infer<typeof ObserverVmOpsArtifactSchema>;

/**
 * `text` with every known secret value replaced by `<redacted>`.
 *
 * Blank needles are skipped, for the reason `findCredentialLeaks` skips them:
 * an empty needle matches everywhere. Longer needles go first, so a secret that
 * contains a shorter one is not left half-visible.
 */
export function redactSecrets(text: string, secrets: readonly string[]): string {
  const needles = secrets
    .filter((s) => typeof s === "string" && s.trim() !== "")
    .sort((a, b) => b.length - a.length);
  let out = text;
  for (const n of needles) out = out.split(n).join("<redacted>");
  return out;
}

/**
 * Sweep, then parse. The shared body of both entry points.
 *
 * ## The sweep runs over the RAW document, and it runs FIRST
 *
 * `parseTicketOpsArtifact` sweeps the parsed value. That misses a secret in a
 * key the schema does not know, because zod strips the key. The harvest still
 * digests and publishes the file whole, token included. Sweeping the raw value
 * covers every string the file holds.
 *
 * Running it before the schema means a document that is both malformed and
 * leaky is refused for the leak. Its schema messages are then never produced.
 *
 * ## The refusal names PATHS, and the paths are redacted too
 *
 * A path over the raw value is built from worker-authored keys. A document that
 * uses the secret as a key as well as a value would otherwise put the secret
 * into this message.
 */
function sweepThenParse<T>(
  schema: z.ZodType<T>,
  kind: string,
  raw: unknown,
  secrets: readonly string[],
): T {
  const leaks = findCredentialLeaks(raw, secrets);
  if (leaks.length > 0) {
    throw new Error(
      `${kind} artifact contains a credential at: ${redactSecrets(leaks.join(", "), secrets)} ` +
        `— refusing to publish it`,
    );
  }
  return schema.parse(raw);
}

/**
 * Parse an `observer-docker-ops.json` document and refuse it if a known secret
 * is inside.
 *
 * One entry point rather than two calls a caller has to remember to pair,
 * because forgetting the second is how a credential gets published into a
 * harvested artifact.
 */
export function parseObserverDockerOpsArtifact(
  raw: unknown,
  secrets: readonly string[] = [],
): ObserverDockerOpsArtifact {
  return sweepThenParse(ObserverDockerOpsArtifactSchema, "observer-docker-ops", raw, secrets);
}

/** The VM twin of `parseObserverDockerOpsArtifact`, for `observer-vm-ops.json`. */
export function parseObserverVmOpsArtifact(
  raw: unknown,
  secrets: readonly string[] = [],
): ObserverVmOpsArtifact {
  return sweepThenParse(ObserverVmOpsArtifactSchema, "observer-vm-ops", raw, secrets);
}
