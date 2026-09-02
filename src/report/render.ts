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

import type {
  AttendedRecord,
  EscapeWatch,
  MergePrecheck,
  RunReport,
  ScheduledTask,
} from "../contracts.ts";
import { voidedForDispatchRoute } from "../attended/voided.ts";

/** Render the whole report as markdown-flavoured text. */
export function renderRunReport(
  report: RunReport,
  notes: readonly string[] = [],
  attended: readonly AttendedRecord[] = [],
  attendedUnverified: readonly { worker: string; reason: string }[] = [],
  /**
   * Workers that took a STAGED dispatch, from `collect`'s ledger scan.
   *
   * Defaulted to empty so every existing caller — and every existing test —
   * renders exactly what it rendered before. A run with no staged dispatch must
   * be byte-identical to its old output; if it is not, this change has altered
   * a report that had nothing to do with it.
   */
  stagedWorkers: readonly string[] = [],
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
  for (const a of attended) lines.push(...renderAttended(a, stagedWorkers.includes(a.worker)));
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

  /**
   * STAGED BUT NOT TRIGGERED (ISC-451) — up here with ATTENDED, for the same
   * reason and one stronger.
   *
   * This module's header forbids a footnote: a degraded row an operator has
   * scrolled past by the time it matters has not been reported. A staged task
   * is the sharpest case of that in the whole report, because everything below
   * this line reads as though the work is under way. `## schedule` will carry
   * the row as `staged`, but a reader who skims the totals sees a task counted
   * and no verdict, and concludes it is running.
   *
   * The line names the REMEDY, not just the state, because unlike every other
   * finding in this report the operator can clear this one in five seconds —
   * and unlike a failure, it will otherwise wait forever.
   */
  const staged = report.schedule.filter((r) => r.state === "staged");
  if (staged.length > 0) {
    lines.push(`## STAGED — ${staged.length} task(s) dispatched and never triggered`);
    for (const row of staged) {
      lines.push(
        `- ${row.id}: staged on worker ${row.worker ?? "unknown"} — the epoch is allocated and ` +
          `the brief is on disk at /policy/dispatch, but no turn has begun`,
      );
    }
    lines.push(
      "  Nothing is wrong and nothing is running: a staged task starts when a person types the",
    );
    lines.push(
      "  trigger at that worker's terminal. To release one instead, `pifleet unstage --task <id>`.",
    );
    lines.push("");
  }

  /**
   * The security surface comes before the totals for the same reason ATTENDED
   * does: a worker that reached for the Docker socket, or one nothing was
   * watching, changes what every number below it is worth. Only FINDINGS are
   * printed here — a run where every worker was armed and nothing tried gets
   * one quiet line at the bottom, because a security section that shouts on
   * every clean run is a section operators learn to skip.
   */
  lines.push(...renderEscapeWatch(report.security.escape_watch));

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
function renderAttended(a: AttendedRecord, staged: boolean): string[] {
  const out: string[] = [];
  const span =
    a.left_at !== null
      ? `from ${a.entered_at} until ${a.left_at}`
      : `since ${a.entered_at} — not handed back; a person may still be driving`;
  out.push(`## ATTENDED — a person drove worker ${a.worker}`);
  out.push(`- ${a.worker}: ${a.mode === "tui" ? "pane is attended" : "pane returned to viewer"}, ${span}`);

  /**
   * THE STAMP IS RE-DERIVED HERE, and only for a run that staged something.
   *
   * `a.voided` was written into `attended.json` when the person took the pane —
   * before any dispatch, when the mode table was the true one. A staged
   * dispatch later in the run makes three of its rows wrong in the direction
   * that matters: it tells the operator no epoch exists when one does, and that
   * a re-dispatch runs the task twice when the file route now dedups. So the
   * printed table is recomputed and the record is left alone; a record that
   * mutates under later events is not a record.
   *
   * A run with nothing staged takes `a.voided` verbatim and is byte-identical
   * to what this printed before the staged route existed.
   */
  const voided = staged
    ? voidedForDispatchRoute(a.mode === "tui" ? "tui" : "rpc", "staged")
    : a.voided;
  if (staged) {
    out.push(
      `- worker ${a.worker} took at least one STAGED dispatch; the rows below are the ` +
        `staged route's, which void less than the mode's — see the epoch rows`,
    );
  }
  if (voided.length > 0) {
    out.push(`- ${voided.length} guarantee(s) do not hold for this run:`);
    for (const v of voided) out.push(`    ${v.isc}: ${v.because}`);
  }
  return out;
}

/**
 * The escape-attempt honeypot's findings (ISC-125).
 *
 * Three outcomes, and the third is why this function is not a one-liner over
 * `attempts > 0`:
 *
 *   - a worker that tried            → ESCAPE ATTEMPT, capitalized, up top
 *   - a worker nothing watched       → NOT WATCHED, equally prominent
 *   - every worker armed and quiet   → one line, at the end, saying so
 *
 * The last one is a CLAIM and is worded as one. "no escape attempts" on its
 * own is the sentence that means nothing — it reads identically whether the
 * detector was running or absent — so the clean line names the number of
 * containers that were actually watched. That is what makes it evidence
 * rather than reassurance.
 */
function renderEscapeWatch(watch: readonly EscapeWatch[]): string[] {
  if (watch.length === 0) return [];
  const out: string[] = [];
  const tried = watch.filter((w) => w.attempts > 0);
  const unwatched = watch.filter((w) => !w.armed);

  for (const w of tried) {
    const count = w.flooded ? `at least ${w.attempts}` : `${w.attempts}`;
    out.push(`## ESCAPE ATTEMPT — worker ${w.worker} reached for the Docker socket`);
    out.push(`- ${count} connect(s) to /var/run/docker.sock, refused and recorded`);
    if (w.first_attempt_at !== null) {
      const span =
        w.last_attempt_at !== null && w.last_attempt_at !== w.first_attempt_at
          ? `${w.first_attempt_at} through ${w.last_attempt_at}`
          : w.first_attempt_at;
      out.push(`    ${span}`);
    }
    if (w.flooded) {
      // Saying the cap out loud, because otherwise the number reads as exact
      // and an operator would size the incident from it.
      out.push("    per-attempt recording hit its cap; the true count is higher");
    }
  }

  for (const w of unwatched) {
    out.push(`## NOT WATCHED — worker ${w.worker} has no armed escape detector`);
    out.push("    No listener reported itself armed in this container, so this");
    out.push("    run makes NO claim either way about escape attempts in it.");
  }

  if (out.length > 0) {
    out.push("");
    return out;
  }

  // The clean case. Deliberately the LAST thing in this block and deliberately
  // not a heading: it is the absence of a finding, and it should not compete
  // for attention with the verdicts below it.
  out.push(
    `escape detector armed in ${watch.length} container(s); no attempt on /var/run/docker.sock observed`,
  );
  out.push("");
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
