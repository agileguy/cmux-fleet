/**
 * Role resolution (SRD §14, Phase 5): map a `TaskSpec.role` to the text that
 * reaches a worker.
 *
 * Resolution returns TEXT and nothing else. It takes no envelope, no config,
 * and no worker identity, so it structurally cannot make a capability
 * decision — the verb allowlist lives in `cloud_allow[]` on the envelope
 * (SRD §5.10) and the tool set lives in role config (SRD §6), neither of
 * which this module can see. A resolver that could reach either would be a
 * second authorization path, one the verbgate and the ledger never hear
 * about.
 *
 * The record below is typed against the contracts seam, deliberately: adding
 * a fourth role to `TaskSpecSchema.role` makes this file fail to compile
 * until a briefing exists. The alternative — a lookup that quietly returns
 * `undefined` for the new role — would dispatch tasks whose role text
 * silently vanished, which is the kind of miss nobody notices until a
 * verifier behaves like a generic worker.
 */

import type { TaskSpec } from "../contracts.ts";
import { INVESTIGATOR_BRIEFING, SRE_BRIEFING, VERIFIER_BRIEFING } from "./briefings.ts";

/** The non-null roles a task may pin (contracts.ts owns the vocabulary). */
export type RoleName = NonNullable<TaskSpec["role"]>;

/** Exhaustive by type: a new role in contracts.ts breaks the build here. */
export const BRIEFINGS: Record<RoleName, string> = {
  sre: SRE_BRIEFING,
  investigator: INVESTIGATOR_BRIEFING,
  verifier: VERIFIER_BRIEFING,
};

export const ROLE_NAMES: readonly RoleName[] = Object.keys(BRIEFINGS).sort() as RoleName[];

/**
 * The briefing for a role, or `null` for the fleet default.
 *
 * `null` resolves to NO role text at all — the worker runs under its
 * config-time standing prompt alone. It is an explicit case rather than a
 * fallthrough, so a task list that never thought about roles composes to
 * exactly the brief its author wrote, with nothing prepended.
 *
 * An unknown role throws. Task lists are schema-validated upstream, so this
 * only fires for a caller that skipped the schema — and that caller must be
 * stopped loudly, because dispatching a task under a briefing that resolved
 * to `undefined` would run it as role-less while `report` still displays the
 * role it was supposed to have.
 */
export function roleBriefing(role: TaskSpec["role"]): string | null {
  if (role === null) return null;
  if (!Object.hasOwn(BRIEFINGS, role)) {
    throw new Error(`unknown role: ${String(role)}`);
  }
  return BRIEFINGS[role];
}

/**
 * Compose the text that reaches the worker: role briefing first, then the
 * task's own brief, both intact.
 *
 * The briefing leads because it is the standing frame the task is read
 * inside — a verifier must know it is a verifier before it reads what to
 * verify. The separator is a plain thematic break, not a header the task
 * text could collide with.
 */
export function composeBrief(role: TaskSpec["role"], taskBrief: string): string {
  const briefing = roleBriefing(role);
  if (briefing === null) return taskBrief;
  return `${briefing}\n\n---\n\n${taskBrief}`;
}
