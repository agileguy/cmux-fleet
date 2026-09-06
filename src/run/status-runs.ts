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
    readonly workers?: readonly { readonly id?: unknown; readonly alive?: unknown }[];
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

/** What one console's worker→run map looks like when it is read off `status`. */
export interface ConsoleRunPins {
  /** Worker → the ONE live run holding it. */
  readonly pins: ReadonlyMap<string, string>;
  /** Workers no live run holds. Ordered as `workers` was given. */
  readonly missing: readonly string[];
  /** Workers more than one live run holds, with the ids, newest-document-order. */
  readonly ambiguous: ReadonlyMap<string, readonly string[]>;
}

/**
 * The console's worker→run map, for `PIFLEET_RELAY_RUNS`.
 *
 * ## Why the launching script is the right place to compute this
 *
 * §6.5 prefers *"a new `pifleet relay --console review` process, started by
 * `scripts/review`"* on the ground that it *"holds the worker→run map the script
 * already computes"*, and `relay.ts`'s own comment concedes the alternative is
 * weaker: *"the script knows which four runs it created, and the scan can only
 * infer from what is on disk."* This is that map, and it is derived from the
 * same document `--recreate` already reads rather than from a second source.
 *
 * ## LIVE workers only, which is the same predicate the scan uses
 *
 * `alive` is `status`'s own (pid, start-time) identity check, and requiring it
 * here is not belt-and-braces: `pifleet down` removes containers and LEAVES
 * DIRECTORIES, so every run the operator has ever started still lists every
 * worker it ever materialised. A pin computed from mere presence would name a
 * dead run.
 *
 * **The consequence of that changed when pins began to decay, and the rule did
 * not.** It is no longer that nothing would notice — `relay.ts:2999-3005`
 * probes each named run and abandons the pinned branch when one fails, so a
 * corpse resolves to the scan's answer rather than to the corpse. It is that the
 * pin then buys NOTHING: a named-but-dead run decays on every pass, so the
 * console pays the full host-wide scan every tick while carrying a variable that
 * says it does not have to. Requiring `alive` is what makes the pin do the job
 * it was set for, rather than what stops it doing harm.
 *
 * ## Ambiguity is reported, never resolved
 *
 * Worker ids are not unique across runs, and two consoles up at once is the
 * ordinary state of this machine. `relay.ts` fails closed on that for a reason
 * worth not re-deciding here — a review dispatched into another fleet's worker
 * is collated as this console's lens — so this function reports the collision
 * and leaves the choice to nobody. The caller's correct response is to emit no
 * pin at all; see the note there for why a PARTIAL pin is worse than none.
 */
export function consoleRunPins(
  statusJson: string,
  workers: readonly string[],
): ConsoleRunPins {
  const holders = new Map<string, string[]>();
  for (const w of workers) holders.set(w, []);

  let doc: StatusDocument;
  try {
    doc = JSON.parse(statusJson) as StatusDocument;
  } catch {
    // Unreadable status pins nothing, exactly as it stops nothing above: the
    // relay then falls back to its own scan, which is the weaker answer and
    // still an answer.
    doc = {};
  }
  const runs = Array.isArray(doc?.runs) ? doc.runs : [];

  for (const run of runs) {
    const runId = run?.run_id;
    if (typeof runId !== "string" || runId === "") continue;
    const entries = Array.isArray(run.workers) ? run.workers : [];
    for (const w of entries) {
      if (typeof w?.id !== "string") continue;
      const held = holders.get(w.id);
      if (held === undefined) continue;
      if (w.alive !== true) continue;
      if (!held.includes(runId)) held.push(runId);
    }
  }

  const pins = new Map<string, string>();
  const missing: string[] = [];
  const ambiguous = new Map<string, readonly string[]>();
  for (const w of workers) {
    const held = holders.get(w) ?? [];
    if (held.length === 1) pins.set(w, held[0]!);
    else if (held.length === 0) missing.push(w);
    else ambiguous.set(w, held);
  }
  return { pins, missing, ambiguous };
}

/**
 * `PIFLEET_RELAY_RUNS`'s value, or `null` when no complete map can be spelled.
 *
 * ## ALL OR NOTHING, and the partial map is the trap
 *
 * **The pin now DECAYS, and this function is the reason that is not enough.**
 * `relay.ts:2968-3005` no longer short-circuits the scan on the mere presence of
 * the variable: every worker the pin NAMES is liveness-probed on every pass, and
 * one dead pinned run abandons the whole pinned branch so the host-wide scan
 * answers instead. An earlier version of this docblock said a set variable means
 * "the host-wide scan never runs", and that sentence is now wrong.
 *
 * **What decay does not reach is the shape this function exists to prevent.**
 * The decay test keys on the workers the pin names — `relay.ts:2997` skips a
 * worker the pin omits with a bare `continue`, BEFORE the liveness probe — so an
 * omitted worker contributes nothing to the decay set. A pin naming three of
 * four workers, all three live, therefore still takes the early return with the
 * fourth absent, and the scan still never runs. Measured, not reasoned:
 * `collator-relay-adapter.test.ts`'s "an explicit pin bypasses the scan entirely"
 * pins two of three seats and asserts the run listing was never called.
 *
 * So a pin emitted while the console is still coming up — three `pifleet up`s
 * still starting, one run visible — freezes that gap, and the relay refuses every
 * fan-out for the missing worker with `run_unresolved` while looking configured.
 * The gap closes only when some OTHER, named worker's run stops being live, at
 * which point the scan runs and answers for everybody including the worker the
 * pin never mentioned. **Repair by unrelated bereavement is not a convergence
 * story**, and it is the whole reason the completeness test below survived the
 * change that made pins decay.
 *
 * The scan is the weaker answer and it has one property the pin does not: it is
 * re-taken on every tick, so it converges as the console comes up. Emitting
 * nothing until the map is complete keeps that, and the completeness test is the
 * whole of this function.
 */
export function relayRunPinValue(map: ConsoleRunPins, workers: readonly string[]): string | null {
  if (map.pins.size !== workers.length) return null;
  return workers.map((w) => `${w}=${map.pins.get(w)!}`).join(",");
}
