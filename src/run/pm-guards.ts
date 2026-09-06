/**
 * The two refusals the ProjectManager loop makes between dispatching a phase
 * and believing its result.
 *
 * ## Why these are here and not in the workflow document
 *
 * §0.2 of `Docs/SRD-FLEET-PROJECT-MANAGER.md` decides that the orchestrator is
 * the calling Claude Code session rather than a fleet worker, and the
 * consequence is that most of the loop is prose in
 * `.claude/skills/fleet/Workflows/ProjectManager.md`. Prose is the right home
 * for the ORDER of the steps and the wrong home for their DECISIONS: a
 * paragraph telling an orchestrator to check something is re-read only when
 * somebody re-reads it, and the two checks below are exactly the ones whose
 * failure mode is a green result.
 *
 * That distinction was learned the expensive way one file over. `ISA.md`
 * ISC-564 recorded that a console's stop-then-respawn ordering *"could not be
 * moved into a module"*, two reviewers falsified it, and the ordering is now
 * `resolveThenRestart` in `fresh-dispatch.ts`. The same sentence would be just
 * as wrong here: the orchestrator's job is to RUN these checks, and it was
 * never the orchestrator's job to define them.
 *
 * ## Both functions are pure, and that is a criterion rather than a taste
 *
 * ISC-556 is an anti-criterion over this whole block: *no criterion in the
 * SRD-FLEET-PM-001 block requires a real terminal, a real model, or the
 * network.* Every input below is data the orchestrator already holds by the
 * time it decides — `dispatch`'s stdout, `status --json`'s stdout, a recorded
 * base sha, an integration record — or an injected answer to a single git
 * question. Nothing here spawns anything, so the tests need no console, no
 * container and no clock.
 */

import { z } from "zod";

/* ────────────────────────────────────────────────────────────────────────────
 * ISC-547 — A DISPATCH THAT DID NOT LAND IS NEVER REPORTED AS ONE
 * ──────────────────────────────────────────────────────────────────────────── */

/**
 * The status fields this decision reads, and nothing else.
 *
 * `status --all --json` carries eighteen fields per worker and this asks about
 * three of them. Declared `loose` on purpose: a snapshot growing a field must
 * not make a guard start refusing dispatches, and a snapshot LOSING one of
 * these three must — which is what `.min(1)` on the id and the explicit
 * nullables below buy.
 */
const StatusWorkerRowSchema = z
  .object({
    id: z.string().min(1),
    phase: z.string().nullable().optional(),
    task_id: z.string().nullable().optional(),
    staged_task_id: z.string().nullable().optional(),
  })
  .loose();

const StatusSnapshotSchema = z
  .object({
    run_id: z.string().optional(),
    workers: z.array(StatusWorkerRowSchema),
  })
  .loose();

export interface ConfirmDispatchInput {
  /** The worker the envelope was dispatched to. */
  readonly worker: string;
  /** The task id the envelope declared. */
  readonly taskId: string;
  /**
   * Whatever the runner returned for `pifleet dispatch --json`.
   *
   * A STRING and not a parsed object, deliberately. The measured failure was a
   * subprocess helper documented as running a subcommand *"swallowing failure"*
   * with `stderr: "ignore"`, which returns `""` for a command that exited 2 —
   * and `""` is a value only the raw text can carry. A caller that parses first
   * has already thrown the evidence away.
   */
  readonly dispatchStdout: string;
  /** Stdout of `pifleet status --run <id> --json`, read AFTER the dispatch. */
  readonly statusJson: string;
}

/**
 * THREE states, and collapsing them to two is the bug this type exists to
 * prevent.
 *
 * `started` is the only one that means a turn is running. `staged` is the
 * envelope accepted durably and the turn NOT yet begun — a real and ordinary
 * state for an attended worker, and the one ISC-551 is named for: *"a fixture
 * where the dispatch payload is `{accepted: true, via: 'staged'}` and the
 * worker remains `idle` with a `staged_task_id`; assert the workflow reports
 * the turn as not started."* An earlier version of this file answered `staged`
 * with `started: true`, because the fleet skill records `via: "staged"` as
 * success — which it is, for the question *did the envelope land*. That is a
 * different question from *did the turn start*, and answering the second with
 * the first is how a loop waits on work nothing is doing.
 */
export type DispatchConfirmation =
  | {
      readonly state: "started";
      readonly started: true;
      readonly detail: string;
    }
  | {
      readonly state: "staged";
      /**
       * FALSE, and this is the line the criterion turns on. Staged is not a
       * failure and it is not a start: the envelope is durable, the worker
       * will pick it up, and nothing is running yet.
       */
      readonly started: false;
      readonly detail: string;
    }
  | {
      readonly state: "refused" | "unconfirmed";
      readonly started: false;
      /**
       * `refused` — the dispatch itself did not land, so nothing was ever
       * staged. `unconfirmed` — the dispatch claims it landed and the fleet
       * does not show it, which is the more dangerous of the two because the
       * happy-path payload is present and reads like success.
       */
      readonly reason: "refused" | "unconfirmed";
      readonly detail: string;
    };

/**
 * Whether a dispatch actually started, answered by `status` and never by the
 * dispatch payload.
 *
 * ## The two failures, and why one check cannot cover both
 *
 * **The dispatch was refused.** `fb38fc8` measured this on the live console:
 * the envelope carried a short SHA where the validator wants forty characters,
 * `dispatch` exited 2, the console's own subprocess helper discarded the exit
 * status and returned `""`, and the script printed *"recreated col-1 into run
 * <id> … and dispatched <path>"* before exiting 0. The inbox was empty and an
 * operator in that position waits for a review that can never run.
 * {@link dispatchProblem} closed it inside `recreateThenDispatch`; this closes
 * it for an orchestrator that shells out itself, which the ProjectManager loop
 * does for every engineer, tester and review seat.
 *
 * **The dispatch landed and the turn never started.** The payload is
 * `{accepted: true, via: "staged"}` and exits 0 whether or not the worker ever
 * picks the envelope up, because an attended (`pane_mode: tui`) worker has no
 * RPC surface — the envelope is written durably and the trigger is not
 * delivered by keystroke. §8.2 step 3 states the consequence in one line:
 * **the JSON cannot tell you the turn never started; only `status` can.**
 *
 * So a `true` from this function is always a statement about the STATUS
 * snapshot. The payload can only ever veto.
 *
 * ## `staged` counts as started, and this is not a loosening
 *
 * A worker sitting `idle` with `staged_task_id` equal to this task has
 * accepted the envelope durably; the fleet skill records `via: "staged"` as
 * success rather than a warning, and re-dispatching on it is the documented
 * mistake. What is NOT started is a worker holding SOMETHING ELSE, or holding
 * nothing at all, and both of those return `unconfirmed` naming what the
 * worker actually has — because "the fleet disagrees with the dispatch" is the
 * fact an operator needs, and the id it disagrees with is how they find out
 * why.
 */
export function confirmDispatchStarted(input: ConfirmDispatchInput): DispatchConfirmation {
  const problem = dispatchProblem(input.dispatchStdout);
  if (problem !== null) {
    return {
      state: "refused",
      started: false,
      reason: "refused",
      detail:
        `the dispatch of ${input.taskId} to ${input.worker} did not land: ${problem}. ` +
        "The worker is up and holding nothing; fix the envelope and re-run the same dispatch.",
    };
  }

  let snapshot: z.infer<typeof StatusSnapshotSchema>;
  try {
    snapshot = StatusSnapshotSchema.parse(JSON.parse(input.statusJson.trim()));
  } catch (err) {
    return {
      state: "unconfirmed",
      started: false,
      reason: "unconfirmed",
      detail:
        `the dispatch of ${input.taskId} to ${input.worker} reported success and its start could ` +
        `not be confirmed, because status --json could not be read: ` +
        `${err instanceof Error ? err.message : String(err)}`,
    };
  }

  const row = snapshot.workers.find((w) => w.id === input.worker);
  if (row === undefined) {
    return {
      state: "unconfirmed",
      started: false,
      reason: "unconfirmed",
      detail:
        `the dispatch of ${input.taskId} reported success and status does not list ${input.worker} ` +
        `at all — it holds ${describeRoster(snapshot.workers.map((w) => w.id))}`,
    };
  }

  if (row.task_id === input.taskId) {
    return {
      state: "started",
      started: true,
      detail: `${input.worker} is holding ${input.taskId} (phase ${row.phase ?? "unknown"})`,
    };
  }
  if (row.staged_task_id === input.taskId) {
    return {
      state: "staged",
      started: false,
      detail:
        `${input.worker} has ${input.taskId} STAGED and the turn has not started (phase ` +
        `${row.phase ?? "unknown"}). The envelope is durable and the worker picks it up without a ` +
        "keystroke, so DO NOT re-dispatch — poll status again. Say this out loud rather than " +
        "waiting silently: a staged envelope and a running turn look identical from the dispatch " +
        "payload, which carries no field that separates them.",
    };
  }

  return {
    state: "unconfirmed",
    started: false,
    reason: "unconfirmed",
    detail:
      `the dispatch of ${input.taskId} to ${input.worker} reported success and the fleet does not ` +
      `show it: the worker is phase ${row.phase ?? "unknown"}, holding ` +
      `${row.task_id ?? "nothing"} with ${row.staged_task_id ?? "nothing"} staged`,
  };
}

/**
 * Why `dispatch`'s stdout does not show a task that landed, or `null`.
 *
 * The three arms are `fresh-dispatch.ts`'s, re-stated here rather than
 * imported, and the duplication is deliberate: that module's copy is reached
 * only through `recreateThenDispatch`, and the ProjectManager loop shells out
 * to the console scripts itself for seats that module never sees. Importing it
 * would mean exporting a private helper across a boundary that has no other
 * reason to exist. **If the arms ever disagree, the source-text test in
 * `pm-guards.test.ts` fails**, which is the relationship worth having between
 * two copies of one judgement.
 */
function dispatchProblem(stdout: string): string | null {
  const text = stdout.trim();
  if (text === "") {
    return "it produced no output at all, which is what a runner that discards a failing exit status returns";
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return `its output is not the JSON --json promises: ${text.slice(0, 200)}`;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return `its output is JSON but not an object: ${text.slice(0, 200)}`;
  }
  const accepted = (parsed as { accepted?: unknown }).accepted;
  if (accepted !== true) {
    return `it was refused — accepted is ${JSON.stringify(accepted)}: ${text.slice(0, 200)}`;
  }
  return null;
}

function describeRoster(ids: readonly string[]): string {
  return ids.length === 0 ? "no workers" : ids.join(", ");
}

/* ────────────────────────────────────────────────────────────────────────────
 * ISC-555 — A TESTER WHOSE CLONE PREDATES THE MERGE IS FLAGGED
 * ──────────────────────────────────────────────────────────────────────────── */

export interface TesterCloneInput {
  /** The tester seat being dispatched to. */
  readonly worker: string;
  /**
   * The clone's baseline — `WorkerWorktree.baseSha`, the `HEAD` the clone was
   * made from. This is the field `pruneWorkerWorktree` already measures "this
   * clone holds work" against, so it is the run tree's own answer to "how old
   * is this checkout" rather than a second one invented here.
   */
  readonly cloneBaseSha: string;
  /**
   * The merge commits the integration step wrote for this phase, in the order
   * the record lists them.
   *
   * A LIST and not the branch tip: a phase merges one worker at a time, each
   * merge is its own commit, and a tester restarted between two of them has a
   * clone that covers the first and not the second. Asking only about the tip
   * would answer that case correctly by luck and the reverse case wrongly.
   */
  readonly mergeCommits: readonly string[];
}

export type TesterCloneVerdict =
  | { readonly fresh: true; readonly detail: string }
  | {
      readonly fresh: false;
      /** The merge commits the clone does not contain, in input order. */
      readonly missing: readonly string[];
      readonly detail: string;
    };

/**
 * Whether a tester's clone contains everything the phase merged — asked before
 * the tester is dispatched, not after it reports.
 *
 * ## The failure this exists to make impossible
 *
 * §8.2 restarts the testers AFTER the integration merge, once per phase, so
 * that "each tester's clone holds both engineers' work". A worker's clone is
 * taken from the launch directory as it stood at `up` time and **has no
 * remotes** — `worktree.ts` strips `origin` deliberately — so a tester cannot
 * fetch the merge afterwards. It cannot notice the gap either: its `/workspace`
 * is a complete, consistent checkout of the previous phase.
 *
 * The result is the worst shape a test result can have. The tester runs a real
 * suite, against a real tree, and reports a real PASS — about work that is one
 * phase old. Nothing in the envelope, the status table, the ledger or the
 * result marks it, and the orchestrator folds it into a phase verdict. ISC-555
 * states it as the anti-criterion it is: *a green result about the previous
 * phase's tree is the failure being prevented.*
 *
 * ## Why ancestry is injected rather than run here
 *
 * The question "is commit X in this clone's history" is `git merge-base
 * --is-ancestor`, and it needs the clone on disk. Taking the ANSWERS as input
 * keeps the decision — which commits matter, what to do when one is missing,
 * what the operator is told — testable with no repository at all, which
 * ISC-556 requires of every criterion in this block. The caller supplies one
 * boolean per merge commit; this supplies the judgement.
 *
 * A clone whose base sha IS a merge commit is fresh for that commit: `git
 * merge-base --is-ancestor X X` is true, and a tester cloned at the exact
 * moment of the merge holds it.
 */
export function testerCloneCoversMerge(
  input: TesterCloneInput,
  contains: (mergeCommit: string) => boolean,
): TesterCloneVerdict {
  const missing = input.mergeCommits.filter((c) => !contains(c));
  if (missing.length === 0) {
    return {
      fresh: true,
      detail:
        `${input.worker}'s clone (base ${short(input.cloneBaseSha)}) contains all ` +
        `${input.mergeCommits.length} merge commit(s) this phase wrote`,
    };
  }
  return {
    fresh: false,
    missing,
    detail:
      `refused: ${input.worker}'s clone is OLDER than this phase's integration merge — its base is ` +
      `${short(input.cloneBaseSha)} and it does not contain ${missing.length} of ` +
      `${input.mergeCommits.length} merge commit(s) (${missing.map(short).join(", ")}). ` +
      "A worker's clone has no remotes and cannot fetch them, so this tester would run a real " +
      "suite against the previous phase's tree and report a real pass about it. Restart the " +
      "tester so it re-clones from the checkout as it now stands, then dispatch.",
  };
}

function short(sha: string): string {
  return sha.length > 12 ? sha.slice(0, 12) : sha;
}
