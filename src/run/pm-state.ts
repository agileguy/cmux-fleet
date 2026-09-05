/**
 * The ProjectManager run state file (SRD §7.6) — Phase 5, task 5.4.
 *
 * `<repo>/.claude/project-manager-state.json`, shaped `pifleet.pmstate/v1`,
 * validated on every read so a resumed run refuses a malformed cursor rather
 * than acting on one. That is the whole of what §13 task 5.4 asks for. This
 * module writes no branch, dispatches no task and reads no run tree — it is
 * the boundary between a JSON file and the loop that resumes from it.
 *
 * ## Two properties carry this file, and neither is the field list
 *
 * **1. `partition` is why the file exists.** §7.6: it is *"the one thing
 * §6.6's table cannot derive from the run tree: which SRD tasks were meant to
 * go where"*. Everything else here is recoverable — the artifacts say which
 * tasks ran, `git log` says which branches landed, the collation says whether
 * a phase was reviewed. So `partition` is not an optional field with a
 * default; it is a REQUIRED key on every phase, its entries must name at
 * least one task and at least one file, no file may have two owners inside a
 * phase (§6.3's rule stated as a schema refusal rather than as prose), every
 * `dispatched` row must trace back to the partition entry that assigned it,
 * and a phase that was dispatched or is claimed complete may not carry an
 * empty one. A phase not yet reached MAY carry `[]`, because §6.4 step 3
 * partitions at the start of a phase and not before — that is the only
 * emptiness this schema tolerates, and it is conditioned on evidence rather
 * than granted by an `.optional()`.
 *
 * **2. The file is advisory in exactly ONE direction.** §7.6: *"it may say a
 * phase was never started, and it may not say a phase was finished."* §6.6
 * names the defect: *"a phase listed in `completed_phases` whose artifacts do
 * not exist is a stale file, not a completed phase, and the run tree wins."*
 *
 * A comment saying so would be worth nothing, because the misuse is one
 * property access — `state.completed_phases.includes(n)` — and no comment
 * survives contact with a caller in a hurry. So the asymmetry is spent on the
 * TYPES instead, in three layers that each fail closed:
 *
 *   - **`readPmState` does not return the document.** It returns a
 *     `PmStateCursor`, which is the document with `completed_phases` REMOVED
 *     and re-exposed as `phases_claimed_complete_unverified`. The convenient
 *     name does not exist at runtime or at the type level, so the misuse does
 *     not compile and does not evaluate; the available name states what the
 *     value is.
 *   - **`phaseCompletionClaim` cannot return "complete".** Its return union
 *     has three arms — `never_started`, `started_not_claimed_complete`,
 *     `claimed_complete_unverified` — and a caller exhaustively switching over
 *     it has no arm to mistake for a finish.
 *   - **`resolvePhaseCompletion` is the only thing in this module that can
 *     say `complete`, and it takes run-tree evidence as a required
 *     parameter.** Evidence that does not cover the phase's intended tasks
 *     returns `stale_file` — §6.6's defect made a value the caller must
 *     handle rather than a hazard it must remember. There is no default
 *     argument and no overload without it, so "resolve it without looking"
 *     is not spellable.
 *
 * The same reasoning removes `"complete"` from the run-level `status` enum
 * (`PM_RUN_STATUS_CLAIMS`): a status the orchestrator writes about itself is a
 * claim, so the value is spelled `claimed_complete` and a document saying
 * `"complete"` is refused. §6.6's one sentence — *"nothing the orchestrator
 * writes is evidence"* — is not weaker for the run than it is for a phase.
 *
 * ## Where §7.6 and the live file disagree
 *
 * §0.6 finding E says §7.6 *"specifies the shape that practice already
 * reached"*, so `.claude/project-manager-state.json` is evidence. It differs
 * from §7.6's list in four ways, each answered deliberately here:
 *
 *   - **It carries no `schema` tag.** Refused, on `collation.ts:488-490`'s
 *     argument that the tag is checked by name rather than inferred. The live
 *     file is a pre-v1 document and must gain the tag to be read by this
 *     module.
 *   - **No phase carries a `partition`.** Also refused for the phases it
 *     claims complete — which is the point of task 5.4 rather than an
 *     accident of it. §7.6 calls `partition` an ADDITION *"the ones §6.3 and
 *     §6.6 require"*, so the live file predating it is expected.
 *   - **`baseline_commit` is a 7-character abbreviation** (`"ca13812"`), where
 *     `pm-integration.ts` pins every sha at 40. Accepted at 7-40 hex here, and
 *     the difference is principled rather than lax: `base_sha` there is
 *     written by `mergeWorkerBranch` from `git rev-parse`, and this one is
 *     typed by an operator recording where a run started.
 *   - **It carries twelve fields §7.6 does not list** — `srd_version`,
 *     `baseline_suite`, `review_at_end_of_each_phase`, `max_review_iterations`,
 *     `parallel_engineers`, `prior_run_state`, `decisions`, `measurements`,
 *     `pause_point`, `resume_from`, `verified_at_pause`, `review_round_status`.
 *     Accepted, because finding E's whole claim is that the file's shape leads
 *     the spec, and because SRD prose elsewhere already depends on two of them
 *     (§2.7 quotes `review_at_end_of_each_phase`; §6.4 step 10 bounds the
 *     review loop with `max_review_iterations`). They are listed explicitly
 *     rather than swept into a passthrough bag, so `.strict()` still catches a
 *     typo.
 *
 * ## What this file may not carry
 *
 * §6.6's table names, row by row, the questions this file must not answer:
 * whether work reached the integration branch is `git log`'s answer, *"not the
 * state file's commit lists"*. So a phase may not carry `commits` or `merged`,
 * refused by name on `pm-integration.ts`'s `notHere` reasoning — `.strict()`
 * alone would answer "unrecognized key", which teaches an author nothing about
 * a field that is deliberately unavailable HERE. For the same reason the
 * `integration` block is a POINTER to §7.2's record and never an inline copy
 * of it: §7.2 owns that shape, and a second spelling of it here is a second
 * thing to drift.
 */

import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { z } from "zod";
import { MAX_ITEMS, MAX_SHORT, MAX_TEXT, SESSION_ID_RE, workerId } from "../contracts.ts";
import { HostPathOutsideRepositoryError, integrationRecordPath } from "./pm-integration.ts";
import { MAX_RELAY_TASK_ID_CHARS } from "./task-ids.ts";
import type { ReviewVerdict } from "./pm-verdict.ts";

export const PM_STATE_SCHEMA = "pifleet.pmstate/v1" as const;

const shortStr = z.string().max(MAX_SHORT);
const text = z.string().max(MAX_TEXT);

/**
 * Refused rather than left to `.strict()` alone — `pm-integration.ts:106-112`'s
 * argument, which `run/collation.ts` made first.
 */
const notHere = (message: string) => z.never({ error: message }).optional();

const taskIdField = z
  .string()
  .max(MAX_RELAY_TASK_ID_CHARS, {
    error: `task_id is longer than ${MAX_RELAY_TASK_ID_CHARS} characters — it names a path segment`,
  })
  .regex(SESSION_ID_RE, {
    error: "task_id must be letters, digits, '.', '_' or '-', beginning and ending alphanumeric",
  });

/**
 * A commit as an OPERATOR types it. 7-40 lowercase hex, deliberately looser
 * than `pm-integration.ts`'s `gitSha40` — see the docblock. Refusing the live
 * file's own `"ca13812"` would refuse the shape §0.6 E says practice reached.
 */
const gitCommitish = z
  .string()
  .regex(/^[0-9a-f]{7,40}$/, { error: "must be a git commit as 7-40 lowercase hex characters" });

/**
 * A path INSIDE the repository, as §6.3's partition means it — the unit of
 * ownership is a repo-relative file. An absolute path or a `..` segment is a
 * host path outside the repository, which §7.2 refuses categorically and
 * which would silently make one phase's partition overlap another repo's
 * tree.
 */
const repoRelativePath = z
  .string()
  .min(1, { error: "a partitioned path may not be empty" })
  .max(MAX_SHORT)
  .refine((p) => !p.startsWith("/"), {
    error: "must be repo-relative, not an absolute host path (§7.2 refuses a host path outside the repository)",
  })
  .refine((p) => !p.split("/").includes(".."), {
    error: "must not contain a '..' segment — a partitioned file lives inside the repository",
  });

// ---------------------------------------------------------------------------
// The review verdict, spelled once.
// ---------------------------------------------------------------------------

/**
 * §7.5's verdict kinds, as `pm-verdict.ts` defines them. Listed here as
 * literals because zod needs values, and pinned to that module's union by the
 * compile-time check below — so a verdict kind added there and forgotten here
 * fails `bun run typecheck` rather than being discovered by a run that cannot
 * read its own state file.
 */
export const PM_REVIEW_VERDICT_KINDS = [
  "VOID",
  "NO_COLLATION",
  "REVIEW_INCOMPLETE",
  "APPROVED",
  "APPROVED_WITH_DISSENT",
  "CHANGES_REQUESTED",
] as const;
export type PmReviewVerdictKind = (typeof PM_REVIEW_VERDICT_KINDS)[number];

type MissingVerdictKinds = Exclude<ReviewVerdict["kind"], PmReviewVerdictKind>;
type ExtraVerdictKinds = Exclude<PmReviewVerdictKind, ReviewVerdict["kind"]>;
const verdictKindsAgree: [MissingVerdictKinds] extends [never]
  ? [ExtraVerdictKinds] extends [never]
    ? true
    : { error: "PM_REVIEW_VERDICT_KINDS lists a kind pm-verdict.ts does not define"; extra: ExtraVerdictKinds }
  : { error: "pm-verdict.ts defines a verdict kind PM_REVIEW_VERDICT_KINDS omits"; missing: MissingVerdictKinds } = true;
void verdictKindsAgree;

// ---------------------------------------------------------------------------
// The run-level status — a CLAIM, and the enum says so.
// ---------------------------------------------------------------------------

/**
 * There is deliberately no `"complete"`. §6.6: *"nothing the orchestrator
 * writes is evidence"* — a run that finished is a run whose artifacts and
 * merges exist, and this file can only claim it. `claimed_complete` is the
 * value, and it reads as what it is at every call site that branches on it.
 */
export const PM_RUN_STATUS_CLAIMS = [
  "not_started",
  "in_progress",
  "paused",
  "blocked",
  "claimed_complete",
  "abandoned",
] as const;
export type PmRunStatusClaim = (typeof PM_RUN_STATUS_CLAIMS)[number];

// ---------------------------------------------------------------------------
// The phase (§7.6's `phases[]`).
// ---------------------------------------------------------------------------

/**
 * One worker's share of a phase. `task_ids` and `files` are both `.min(1)`:
 * §6.3's unit of ownership is a FILE, and §13's own preamble says *"a task
 * naming no file cannot be partitioned and will serialise"* — so an entry
 * naming no file is not a partition entry, it is a note.
 */
export const PmPartitionEntrySchema = z
  .object({
    worker: workerId,
    task_ids: z
      .array(taskIdField)
      .min(1, { error: "a partition entry must name at least one SRD task — that is what a partition IS (§7.6)" })
      .max(MAX_ITEMS),
    files: z
      .array(repoRelativePath)
      .min(1, {
        error:
          "a partition entry must name at least one file — §6.3 partitions by file ownership, and §13 says a task naming no file cannot be partitioned",
      })
      .max(MAX_ITEMS),
  })
  .strict();
export type PmPartitionEntry = z.infer<typeof PmPartitionEntrySchema>;

/**
 * One dispatch. `run_id` is recorded and never treated as durable: §6.4 notes
 * that `--restart` produces a NEW run id, so the stable key across a restart
 * is `task_id`. Both are kept because a resumed run needs the task id to ask
 * `artifacts` and the run id to know which run it last saw.
 */
export const PmDispatchRowSchema = z
  .object({
    worker: workerId,
    task_id: taskIdField,
    run_id: shortStr,
  })
  .strict();
export type PmDispatchRow = z.infer<typeof PmDispatchRowSchema>;

/**
 * §7.6 offers `integration: {…}` *"or a pointer to §7.2's record"*. The
 * pointer arm is taken and the inline arm is refused by name: `integration.json`
 * already carries the merge, `readIntegrationRecord` already validates it, and
 * a copy of those fields here would be a second spelling that drifts the first
 * time a merge is re-run. `record` must be the canonical path for THIS phase,
 * derived from `pm-integration.ts` rather than re-typed.
 */
export const PmIntegrationPointerSchema = z
  .object({
    record: repoRelativePath,

    workers: notHere(
      "an integration pointer may not inline §7.2's `workers` rows — point at " +
        "`.claude/project-manager/phase-<n>/integration.json` and let `readIntegrationRecord` validate it.",
    ),
    merge_commit: notHere(
      "a state-file phase may not name a merge commit (§6.6) — whether work reached the integration " +
        "branch is `git log`'s answer, not the state file's.",
    ),
  })
  .strict();
export type PmIntegrationPointer = z.infer<typeof PmIntegrationPointerSchema>;

export const PmPhaseReviewSchema = z
  .object({
    parent_task_id: taskIdField,
    collate_task_id: taskIdField,
    /**
     * §7.5's gate 1 numbers as they were recorded. `reported` may not exceed
     * `dispatched` — a collation reporting more lenses than were dispatched
     * is not a low-coverage round, it is a corrupt record.
     */
    coverage: z
      .object({
        reported: z.number().int().nonnegative(),
        dispatched: z.number().int().nonnegative(),
      })
      .strict()
      .superRefine((c, ctx) => {
        if (c.reported > c.dispatched) {
          ctx.addIssue({
            code: "custom",
            path: ["reported"],
            message: `coverage.reported (${c.reported}) exceeds coverage.dispatched (${c.dispatched})`,
          });
        }
      }),
    verdict: z.enum(PM_REVIEW_VERDICT_KINDS),
    iteration: z.number().int().nonnegative(),
  })
  .strict();
export type PmPhaseReview = z.infer<typeof PmPhaseReviewSchema>;

/**
 * `partition` is a REQUIRED key with no default. That is the type-level half
 * of §7.6's *"the field that makes a resumed run possible"*: a caller
 * constructing a phase cannot omit it, and a document missing it is refused
 * before anything reads it. The conditional non-emptiness — dispatched or
 * claimed complete implies at least one entry — needs `completed_phases`, so
 * it lives in the document's own refinement below.
 */
export const PmPhaseSchema = z
  .object({
    n: z.number().int().nonnegative(),
    slug: shortStr,
    name: shortStr,
    partition: z.array(PmPartitionEntrySchema).max(MAX_ITEMS),
    dispatched: z.array(PmDispatchRowSchema).max(MAX_ITEMS).default([]),
    integration: PmIntegrationPointerSchema.nullable().default(null),
    review: PmPhaseReviewSchema.nullable().default(null),

    // ── Refused (§6.6's table, row by row).
    commits: notHere(
      "a state-file phase may not carry a commit list (§6.6) — *'did their work reach the integration " +
        "branch?'* is answered by `git log` and `git merge-base --is-ancestor`, *'not the state file's commit lists'*.",
    ),
    merged: notHere(
      "a state-file phase may not record that it merged (§6.6) — an ancestry check on the integration " +
        "branch answers that, and a boolean here would be a cursor pretending to be evidence.",
    ),
    artifacts: notHere(
      "a state-file phase may not carry artifacts (§6.6) — *'did phase N's engineers run?'* is " +
        "`pifleet artifacts --task <id> --run <id> --json`, never this file.",
    ),
  })
  .strict()
  .superRefine((phase, ctx) => {
    // §6.3 rule 2, as a refusal: "no file appears in two partitions".
    const fileOwner = new Map<string, string>();
    const taskOwner = new Map<string, string>();
    phase.partition.forEach((entry, i) => {
      for (const f of entry.files) {
        const prior = fileOwner.get(f);
        if (prior !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["partition", i, "files"],
            message:
              `file "${f}" is owned by both "${prior}" and "${entry.worker}" in phase ${phase.n} — ` +
              "§6.3: a file has one owner per phase, because an overlap that is free in one checkout is a merge conflict in two.",
          });
        } else {
          fileOwner.set(f, entry.worker);
        }
      }
      for (const t of entry.task_ids) {
        const prior = taskOwner.get(t);
        if (prior !== undefined) {
          ctx.addIssue({
            code: "custom",
            path: ["partition", i, "task_ids"],
            message:
              `task "${t}" is assigned to both "${prior}" and "${entry.worker}" in phase ${phase.n} — ` +
              "the partition is the record of which SRD tasks were meant to go WHERE (§7.6), and two answers is no answer.",
          });
        } else {
          taskOwner.set(t, entry.worker);
        }
      }
    });

    // A dispatch that the partition never assigned makes the file unable to
    // answer the one question §6.6 says only it can.
    phase.dispatched.forEach((row, i) => {
      const owner = taskOwner.get(row.task_id);
      if (owner === undefined) {
        ctx.addIssue({
          code: "custom",
          path: ["dispatched", i, "task_id"],
          message:
            `phase ${phase.n} dispatched task "${row.task_id}", which no partition entry assigns — ` +
            "the partition is why this file exists (§7.6), so a dispatch it does not cover is unresumable.",
        });
      } else if (owner !== row.worker) {
        ctx.addIssue({
          code: "custom",
          path: ["dispatched", i, "worker"],
          message:
            `phase ${phase.n} dispatched task "${row.task_id}" to "${row.worker}", but the partition assigns it to "${owner}".`,
        });
      }
    });

    if (phase.integration !== null) {
      const expected = canonicalIntegrationRecordPath(phase.n);
      if (phase.integration.record !== expected) {
        ctx.addIssue({
          code: "custom",
          path: ["integration", "record"],
          message:
            `phase ${phase.n}'s integration pointer is "${phase.integration.record}", but §7.2's record for ` +
            `phase ${phase.n} is "${expected}" — a pointer at another phase's record resumes the wrong merge.`,
        });
      }
    }
  });
export type PmPhase = z.infer<typeof PmPhaseSchema>;

/**
 * §7.2's path for one phase's record, repo-relative, DERIVED from
 * `integrationRecordPath` rather than re-typed — the point being that if that
 * module moves the record, this follows instead of silently disagreeing.
 */
export function canonicalIntegrationRecordPath(phase: number): string {
  return relative(sep, integrationRecordPath(sep, phase));
}

// ---------------------------------------------------------------------------
// The document (§7.6's field list, plus what the live file already carries).
// ---------------------------------------------------------------------------

const ConsoleRecordSchema = z
  .object({
    /**
     * The console's LAUNCH DIRECTORY, which becomes the run's repository
     * (§8.2). Deliberately not constrained to `repo_path`: §0.5 correction 2
     * records that `--restart` cannot repoint a console, and the live state
     * file's own `stale_worker_remotes_2026_09_05` measurement shows a
     * development console launched from a DIFFERENT repository than the one
     * the run is managing. Refusing that here would refuse the measurement.
     */
    launched_from: shortStr,
    workspace_id: shortStr,
  })
  .strict();

export const PmStateDocumentSchema = z
  .object({
    schema: z.literal(PM_STATE_SCHEMA, {
      error:
        `not a ${PM_STATE_SCHEMA} document. The tag is checked by name rather than inferred, so a ` +
        "pre-v1 state file (the live one carries no tag at all) is refused rather than half-read.",
    }),

    // ── §7.6's list.
    srd_path: shortStr,
    repo_path: shortStr,
    base_branch: shortStr,
    baseline_commit: gitCommitish,
    branch_model: z.enum(["long-lived", "per-phase"]),
    branch: shortStr,
    total_phases: z.number().int().nonnegative(),
    current_phase: z.number().int().nonnegative(),
    completed_phases: z.array(z.number().int().nonnegative()).max(MAX_ITEMS).default([]),
    status: z.enum(PM_RUN_STATUS_CLAIMS),
    consoles: z
      .object({
        development: ConsoleRecordSchema.nullable().default(null),
        review: ConsoleRecordSchema.nullable().default(null),
      })
      .strict()
      .default({ development: null, review: null }),
    phases: z.array(PmPhaseSchema).max(MAX_ITEMS),
    answered_questions: z.record(shortStr, text).default({}),
    /** sha → *"defect found during integration, not in the SRD"* (§2.7). */
    out_of_band_commits: z.record(gitCommitish, text).default({}),
    pr_policy: text.default(""),

    // ── Carried by the live file and not by §7.6's list (§0.6 finding E).
    srd_version: shortStr.default(""),
    baseline_suite: text.default(""),
    review_at_end_of_each_phase: z.boolean().default(true),
    max_review_iterations: z.number().int().positive().default(3),
    parallel_engineers: z.number().int().positive().default(2),
    prior_run_state: text.default(""),
    decisions: z.record(shortStr, text).default({}),
    measurements: z.record(shortStr, text).default({}),
    pause_point: text.default(""),
    resume_from: text.default(""),
    verified_at_pause: text.default(""),
    review_round_status: text.default(""),
  })
  .strict()
  .superRefine((doc, ctx) => {
    const byNumber = new Map<number, PmPhase>();
    doc.phases.forEach((phase, i) => {
      if (byNumber.has(phase.n)) {
        ctx.addIssue({
          code: "custom",
          path: ["phases", i, "n"],
          message: `phase ${phase.n} appears twice — a phase number is this file's only key into a phase.`,
        });
      }
      byNumber.set(phase.n, phase);
    });

    if (doc.total_phases !== doc.phases.length) {
      ctx.addIssue({
        code: "custom",
        path: ["total_phases"],
        message: `total_phases is ${doc.total_phases} but phases[] holds ${doc.phases.length} entries.`,
      });
    }

    if (!byNumber.has(doc.current_phase)) {
      ctx.addIssue({
        code: "custom",
        path: ["current_phase"],
        message: `current_phase ${doc.current_phase} names no phase in phases[].`,
      });
    }

    const seenCompleted = new Set<number>();
    doc.completed_phases.forEach((n, i) => {
      if (seenCompleted.has(n)) {
        ctx.addIssue({
          code: "custom",
          path: ["completed_phases", i],
          message: `phase ${n} is listed twice in completed_phases.`,
        });
      }
      seenCompleted.add(n);
      if (!byNumber.has(n)) {
        ctx.addIssue({
          code: "custom",
          path: ["completed_phases", i],
          message: `completed_phases names phase ${n}, which is not in phases[].`,
        });
      }
    });

    /*
     * The conditional that makes `partition` load-bearing rather than
     * decorative. An UNREACHED phase may carry `[]` — §6.4 step 3 partitions
     * at the start of a phase, so a plan for phase 6 written during phase 2
     * legitimately has none. A phase that was DISPATCHED, or that this file
     * CLAIMS complete, may not: §6.6's resumed run reads the partition first
     * and asks the run tree about each intended task id, and with no
     * partition there is no question to ask.
     */
    doc.phases.forEach((phase, i) => {
      if (phase.partition.length > 0) return;
      const claimed = seenCompleted.has(phase.n);
      const dispatched = phase.dispatched.length > 0;
      if (!claimed && !dispatched) return;
      ctx.addIssue({
        code: "custom",
        path: ["phases", i, "partition"],
        message:
          `phase ${phase.n} is ${claimed ? "listed in completed_phases" : "recorded as dispatched"} but carries an ` +
          "empty partition — §7.6: the partition is *'the one thing §6.6's table cannot derive from the run tree: " +
          "which SRD tasks were meant to go where'*, so a reached phase without one cannot be resumed or falsified.",
      });
    });
  });
export type PmStateDocument = z.infer<typeof PmStateDocumentSchema>;

// ---------------------------------------------------------------------------
// The cursor — what a reader gets, and what it deliberately cannot reach.
// ---------------------------------------------------------------------------

/**
 * The document as a READER sees it: `completed_phases` is gone and its value
 * is exposed under a name that states what it is.
 *
 * `Omit` is doing real work here rather than decorating: `cursor.completed_phases`
 * is a type error AND `undefined` at runtime, so the one-line misuse §6.6
 * warns about does not compile and does not silently evaluate to a truthy
 * `includes`. Everything else is passed through unchanged, because everything
 * else in this file is either intent (which it is authoritative for) or a
 * cursor whose name already says so.
 */
export type PmStateCursor = Omit<PmStateDocument, "completed_phases"> & {
  /** Where this cursor was read from — carried so a diagnosis can name the file. */
  readonly source_path: string;
  /**
   * The phases this file CLAIMS are finished. §7.6: *"it may not say a phase
   * was finished"* — so the value is here, and the name is the guard rail.
   * Feed it to `resolvePhaseCompletion` with run-tree evidence; do not branch
   * on it.
   */
  readonly phases_claimed_complete_unverified: readonly number[];
};

/**
 * What the file may say about a phase, with **no `complete` arm**. A caller
 * that switches exhaustively over this cannot reach a finish, which is the
 * point: §7.6's *"it may not say a phase was finished"* becomes a shape rather
 * than a warning.
 */
export type PhaseCompletionClaim =
  /**
   * The one direction the file is authoritative in (§7.6): not claimed, never
   * dispatched, and not the phase in progress. A resumed run may act on this
   * without asking the run tree.
   */
  | { readonly kind: "never_started"; readonly phase: number }
  /** Dispatched, or in progress, and not claimed finished. */
  | { readonly kind: "started_not_claimed_complete"; readonly phase: number }
  /**
   * `completed_phases` names it. This is a CLAIM. `verify_with` carries the
   * §6.6 commands that would falsify it, so the caller holding this value
   * also holds the recipe for resolving it.
   */
  | {
      readonly kind: "claimed_complete_unverified";
      readonly phase: number;
      readonly intended_task_ids: readonly string[];
      readonly verify_with: readonly string[];
    };

/**
 * The run-tree facts §6.6's table names, supplied by the caller. This module
 * runs no `pifleet` verb and no `git` command — it is a schema and a cursor —
 * so the evidence arrives as data and `resolvePhaseCompletion` is a pure
 * function over it.
 */
export interface PhaseRunTreeEvidence {
  /** Task ids with a result envelope: `pifleet artifacts --task <id> --run <id> --json`. */
  readonly tasks_with_artifacts: readonly string[];
  /** Task ids whose worker branch is already an ancestor of the integration branch. */
  readonly task_ids_merged: readonly string[];
}

/** The only value in this module that can say a phase is done. */
export type PhaseResolution =
  /** Every intended task has an artifact and every branch has landed. */
  | { readonly kind: "complete"; readonly phase: number }
  /**
   * §6.6's named defect: *"a phase listed in `completed_phases` whose
   * artifacts do not exist is a stale file, not a completed phase, and the run
   * tree wins."* Distinguished from `incomplete` because the two need
   * different operator responses — this one means the file lied.
   */
  | {
      readonly kind: "stale_file";
      readonly phase: number;
      readonly missing_artifacts: readonly string[];
      readonly unmerged: readonly string[];
    }
  /** Work is genuinely outstanding, and the file never claimed otherwise. */
  | {
      readonly kind: "incomplete";
      readonly phase: number;
      readonly missing_artifacts: readonly string[];
      readonly unmerged: readonly string[];
    }
  /**
   * The phase carries no partition, so there is nothing to ask the run tree
   * about. §7.6's sentence turned into a return value: without the partition
   * this file has no reason to exist and no answer to give.
   */
  | { readonly kind: "no_partition"; readonly phase: number };

function phaseOrThrow(cursor: PmStateCursor, phase: number): PmPhase {
  const found = cursor.phases.find((p) => p.n === phase);
  if (found === undefined) {
    throw new RangeError(`${cursor.source_path} carries no phase ${phase} (phases: ${cursor.phases.map((p) => p.n).join(", ")})`);
  }
  return found;
}

/** Every task id the partition assigns for one phase, in partition order. */
export function intendedTaskIds(phase: PmPhase): string[] {
  return phase.partition.flatMap((entry) => entry.task_ids);
}

/**
 * What the file claims about one phase — and, by construction, never that it
 * finished. Throws `RangeError` for a phase the file does not describe rather
 * than returning `never_started`, because "no such phase" and "a phase nobody
 * started" are different facts and conflating them is how a resumed run
 * skips work.
 */
export function phaseCompletionClaim(cursor: PmStateCursor, phase: number): PhaseCompletionClaim {
  const p = phaseOrThrow(cursor, phase);
  if (cursor.phases_claimed_complete_unverified.includes(phase)) {
    const intended = intendedTaskIds(p);
    return {
      kind: "claimed_complete_unverified",
      phase,
      intended_task_ids: intended,
      verify_with: [
        ...intended.map((id) => `pifleet artifacts --task ${id} --run <run-id> --json`),
        `git -C ${cursor.repo_path} merge-base --is-ancestor <worker-branch> ${cursor.branch}`,
      ],
    };
  }
  if (p.dispatched.length > 0 || cursor.current_phase === phase) {
    return { kind: "started_not_claimed_complete", phase };
  }
  return { kind: "never_started", phase };
}

/**
 * Resolve a phase against the run tree. **`evidence` is required and has no
 * default** — that is the enforcement, not a convention: there is no way to
 * spell this call without supplying the facts, so a caller cannot get
 * `complete` out of the file alone.
 *
 * The run tree wins in BOTH directions. Evidence covering every intended task
 * returns `complete` even when the file never claimed it (a run that crashed
 * after the work and before the write), and a claim without evidence returns
 * `stale_file` — §6.6's *"the run tree wins"* stated once, symmetrically.
 */
export function resolvePhaseCompletion(
  cursor: PmStateCursor,
  phase: number,
  evidence: PhaseRunTreeEvidence,
): PhaseResolution {
  const p = phaseOrThrow(cursor, phase);
  const intended = intendedTaskIds(p);
  if (intended.length === 0) return { kind: "no_partition", phase };

  const withArtifacts = new Set(evidence.tasks_with_artifacts);
  const merged = new Set(evidence.task_ids_merged);
  const missingArtifacts = intended.filter((id) => !withArtifacts.has(id));
  const unmerged = intended.filter((id) => !merged.has(id));

  if (missingArtifacts.length === 0 && unmerged.length === 0) {
    return { kind: "complete", phase };
  }
  const claimed = cursor.phases_claimed_complete_unverified.includes(phase);
  return {
    kind: claimed ? "stale_file" : "incomplete",
    phase,
    missing_artifacts: missingArtifacts,
    unmerged,
  };
}

// ---------------------------------------------------------------------------
// File I/O — the same refusals `pm-integration.ts` makes, for the same reasons.
// ---------------------------------------------------------------------------

/**
 * Re-implemented rather than imported because `pm-integration.ts` does not
 * export its copy and that file belongs to §7.2's task. The ERROR is imported,
 * so one `catch (e) { if (e instanceof HostPathOutsideRepositoryError) … }`
 * covers both PM modules instead of two.
 */
async function assertRepositoryRoot(dir: string): Promise<void> {
  const gitPath = join(resolve(dir), ".git");
  let st: Awaited<ReturnType<typeof lstat>>;
  try {
    st = await lstat(gitPath);
  } catch {
    throw new HostPathOutsideRepositoryError(dir);
  }
  // A directory (ordinary repo) or a file (a linked worktree's `gitdir:`
  // pointer) both mean `dir` is a checkout's top level. Anything else is not.
  if (!st.isDirectory() && !st.isFile()) {
    throw new HostPathOutsideRepositoryError(dir);
  }
}

/** §7.6's exact path: `<repo>/.claude/project-manager-state.json`. */
export function pmStatePath(repoRoot: string): string {
  return join(resolve(repoRoot), ".claude", "project-manager-state.json");
}

/** Validate, then write. A document that would not survive a read is not written. */
export async function writePmState(repoRoot: string, document: PmStateDocument): Promise<void> {
  await assertRepositoryRoot(repoRoot);
  const parsed = PmStateDocumentSchema.parse(document);
  const path = pmStatePath(repoRoot);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(parsed, null, 2)}\n`, "utf8");
}

/** Fold a cursor back into the document shape, for a run that updates and rewrites it. */
export function toPmStateDocument(cursor: PmStateCursor): PmStateDocument {
  const { source_path: _source, phases_claimed_complete_unverified, ...rest } = cursor;
  return PmStateDocumentSchema.parse({
    ...rest,
    completed_phases: [...phases_claimed_complete_unverified],
  });
}

/**
 * Read and validate (§7.6, task 5.4) — *"so a resumed run refuses a malformed
 * cursor rather than acting on one"*.
 *
 * Every failure names the FILE. `test/unit/durable-reader-wrapping.test.ts`
 * scans `src/` for a bare `Schema.parse` on file bytes because a raw
 * `ZodError` names a field path and no file, and this reader in particular is
 * opened on RESUME — when the run that wrote it is over and its author is not
 * around to ask which of three state files went bad.
 */
export async function readPmState(repoRoot: string): Promise<PmStateCursor> {
  await assertRepositoryRoot(repoRoot);
  const path = pmStatePath(repoRoot);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (err) {
    throw new Error(`could not read the ProjectManager state file at ${path}: ${String(err)}`);
  }
  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(raw);
  } catch (err) {
    throw new Error(`the ProjectManager state file at ${path} is not valid JSON: ${String(err)}`);
  }
  let document: PmStateDocument;
  try {
    document = PmStateDocumentSchema.parse(parsedJson);
  } catch (err) {
    throw new Error(`the ProjectManager state file at ${path} is malformed: ${String(err)}`);
  }
  const { completed_phases, ...rest } = document;
  return { ...rest, source_path: path, phases_claimed_complete_unverified: completed_phases };
}
