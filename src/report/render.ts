/**
 * Human rendering of a RunReport (SRD §10, §14.2).
 *
 * The JSON side of `report` is the contract; this side is for the operator
 * reading a terminal after something went wrong. Two wording rules are
 * load-bearing:
 *
 * - A clean pre-check is printed as "would merge cleanly … as of this check —
 *   NOT merged". This project already shipped a `down` that printed
 *   `"clean": true` over a leaked tmux session; a reader skimming for the word
 *   "clean" must not be able to walk away believing something landed.
 *
 * - Discrepant or degraded rows are surfaced inline, never appended as a
 *   footnote the operator has scrolled past by the time they matter.
 */

import type { MergePrecheck, RunReport, ScheduledTask } from "../contracts.ts";

/** Render the whole report as markdown-flavoured text. */
export function renderRunReport(report: RunReport, notes: readonly string[] = []): string {
  const lines: string[] = [];
  lines.push(`# pifleet run ${report.run_id}`);
  lines.push(`generated ${report.generated_at}`);
  lines.push("");

  const t = report.totals;
  lines.push(
    `${t.tasks} task(s): ${t.done} done, ${t.blocked} blocked, ${t.failed} failed`,
  );
  lines.push("");

  lines.push("## schedule");
  if (report.schedule.length === 0) {
    lines.push("no tasks were dispatched in this run");
  }
  for (const row of report.schedule) lines.push(renderScheduleRow(row));
  lines.push("");

  lines.push("## merge pre-check");
  if (report.merge.length === 0) {
    lines.push("no worker branches to check");
  }
  for (const m of report.merge) lines.push(...renderPrecheck(m));

  if (notes.length > 0) {
    lines.push("");
    lines.push("## collection notes");
    for (const n of notes) lines.push(`- ${n}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderScheduleRow(row: ScheduledTask): string {
  const parts = [`- ${row.id}: ${row.state}`];
  if (row.worker !== null) parts.push(`worker=${row.worker}`);
  if (row.verdict !== null) parts.push(`verdict=${row.verdict}`);
  // The cause, not just the cascade: `blocked` alone tells the operator
  // nothing about which dependency to go look at.
  if (row.blocked_by !== null) parts.push(`blocked by ${row.blocked_by}`);
  else if (row.state === "waiting" && row.depends_on.length > 0) {
    parts.push(`waiting on ${row.depends_on.join(", ")}`);
  }
  return parts.join("  ");
}

function renderPrecheck(m: MergePrecheck): string[] {
  const out: string[] = [];
  const base = m.base_ref.slice(0, 12);
  if (m.clean) {
    // "as of this check" and "NOT merged" are the sentence. Shortening it to
    // "clean" is how a pre-check gets read as a merge that happened.
    out.push(
      `- ${m.worker} (${m.branch}): would merge cleanly onto ${base} as of this check — NOT merged`,
    );
  } else if (m.conflicting_paths.length === 0 && m.conflicts_with.length === 0) {
    // Not clean and not conflicting: the branch could not be checked at all.
    out.push(`- ${m.worker} (${m.branch}): could not be checked`);
  } else {
    out.push(`- ${m.worker} (${m.branch}): CONFLICTS`);
  }
  if (m.conflicts_with.length > 0) {
    // Worker ids, not paths, lead: the operator's next act is a conversation
    // with whoever owns the other branch.
    out.push(`    talk to: ${m.conflicts_with.join(", ")}`);
  }
  for (const p of m.conflicting_paths) out.push(`    conflict: ${p}`);
  if (m.detail !== "") out.push(`    ${m.detail}`);
  return out;
}
