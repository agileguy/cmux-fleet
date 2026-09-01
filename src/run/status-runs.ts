/**
 * Reading `pifleet status --all --json` back, for the one question a console
 * launcher has to ask it: WHICH RUNS ARE MINE?
 *
 * ## Why this exists at all
 *
 * `scripts/operations --recreate` stops every live run, and that is correct for
 * that console because both of its runs are its own. `scripts/development`
 * cannot copy it. The two consoles stand side by side, each holding runs the
 * other must not touch, so a development rebuild that stopped "every live run"
 * would tear down the operations console — a destructive action with no
 * relation to what the operator asked for, and one whose damage is invisible
 * until they switch workspaces and find four dead panes.
 *
 * So the filter is the feature, and it lives here rather than inline in the
 * script because a script's top level runs `main()` on import: a helper defined
 * there cannot be unit tested without opening a workspace as a side effect.
 *
 * ## `JSON.parse`, not a scanner
 *
 * `status --json` writes ONE document to stdout and its warnings to stderr, and
 * every caller here spawns it with stderr ignored — so stdout is either clean
 * JSON or nothing. An earlier draft of this reached for a regex over the raw
 * text on the theory that a warning might be glued to the front; that theory
 * was wrong, and a scanner would have matched a worker id appearing anywhere in
 * a run's JSON, `session_path` included, rather than only in an `id` field.
 *
 * A document that does not parse yields NO runs rather than throwing. The
 * caller is a best-effort teardown before a rebuild: failing to read the status
 * means stopping nothing, which leaves containers running — untidy, and
 * strictly better than refusing to open the console.
 */

/** The sliver of `status --json` this module reads. Everything else is ignored. */
interface StatusDocument {
  readonly runs?: readonly {
    readonly run_id?: unknown;
    readonly workers?: readonly { readonly id?: unknown }[];
  }[];
}

/**
 * The ids of runs holding at least one of `workers`.
 *
 * Order follows the document, and ids are DE-DUPLICATED: one run holding two of
 * the named workers is one `down`, and issuing the second would report a run
 * that no longer exists as a failure to stop it.
 */
export function runsHoldingAny(statusJson: string, workers: ReadonlySet<string>): string[] {
  if (workers.size === 0) return [];

  let doc: StatusDocument;
  try {
    doc = JSON.parse(statusJson) as StatusDocument;
  } catch {
    // See the docblock: unreadable status means stop nothing.
    return [];
  }
  if (!Array.isArray(doc?.runs)) return [];

  const out: string[] = [];
  const seen = new Set<string>();
  for (const run of doc.runs) {
    const id = run?.run_id;
    if (typeof id !== "string" || id === "" || seen.has(id)) continue;
    // A run with no `workers` array holds none of them — not all of them.
    // Defaulting the other way would make a malformed entry stop everything,
    // which is the exact blast radius this function exists to bound.
    const ids = Array.isArray(run.workers) ? run.workers : [];
    if (ids.some((w: { readonly id?: unknown }) => typeof w?.id === "string" && workers.has(w.id))) {
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}
