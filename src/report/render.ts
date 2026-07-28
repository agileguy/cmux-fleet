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

import type { AttendedRecord, MergePrecheck, RunReport, ScheduledTask } from "../contracts.ts";

/** Render the whole report as markdown-flavoured text. */
export function renderRunReport(
  report: RunReport,
  notes: readonly string[] = [],
  attended: readonly AttendedRecord[] = [],
  attendedUnverified: readonly { worker: string; reason: string }[] = [],
): string {
  const lines: string[] = [];
  lines.push(`# pifleet run ${report.run_id}`);
  lines.push(`generated ${report.generated_at}`);
  lines.push("");

  /**
   * Attended workers come FIRST — before the totals, before any verdict.
   * Every number below this line means something weaker once a person typed
   * into a pane, so the reader must meet this section before they meet a
   * verdict they might believe. A footnote here would be the exact
   * scrolled-past shape this module's header forbids.
   */
  for (const a of attended) lines.push(...renderAttended(a));
  /**
   * An unverifiable record gets the SAME prominence as a verified one, and
   * for a stronger reason: a record that is missing or unreadable is the
   * case where the run is most certainly attended and the detail of how is
   * gone. This was a bottom-of-report note, which is the scrolled-past shape
   * this module's header forbids.
   */
  for (const u of attendedUnverified) {
    lines.push(`## ATTENDED (UNVERIFIED) — worker ${u.worker}`);
    lines.push(`    ${u.reason}`);
    lines.push("    Treat this run as attended: the voided guarantees are unknown.");
  }
  if (attended.length > 0 || attendedUnverified.length > 0) lines.push("");

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

/**
 * One attended worker. "ATTENDED" is capitalized for the same reason the
 * pre-check says "NOT merged": a skimming reader must not be able to miss it.
 * A still-open session ("not handed back") is stated outright — a verdict
 * over a pane a person still owns is a diff still in motion.
 */
function renderAttended(a: AttendedRecord): string[] {
  const out: string[] = [];
  const span =
    a.left_at !== null
      ? `from ${a.entered_at} until ${a.left_at}`
      : `since ${a.entered_at} — not handed back; a person may still be driving`;
  out.push(`## ATTENDED — a person drove worker ${a.worker}`);
  out.push(`- ${a.worker}: ${a.mode === "tui" ? "pane is attended" : "pane returned to viewer"}, ${span}`);
  if (a.voided.length > 0) {
    out.push(`- ${a.voided.length} guarantee(s) do not hold for this run:`);
    for (const v of a.voided) out.push(`    ${v.isc}: ${v.because}`);
  }
  return out;
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
