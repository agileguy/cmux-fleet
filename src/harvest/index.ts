/**
 * Harvest assembly and adjudication (SRD §8, §7.3).
 *
 * A1 (envelope, advisory) and A2 (repository, authoritative) are combined
 * here into the `Harvest` object `pifleet artifacts` emits. The primacy rule
 * (§7.2) is enforced structurally: the claimed envelope enters adjudication
 * only through `adjudicate`, whose lattice can lower a derived verdict but
 * never raise it.
 *
 * `harvest_status` is orthogonal to the verdict (§8.4): it says whether the
 * HARVEST is trustworthy, not whether the task succeeded. A machine consumer
 * reads it from the payload because the exit code is deliberately useless for
 * this — `artifacts` is a pure read and exits 0 for "no artifacts" and
 * "task failed" alike.
 */

import { readdir } from "node:fs/promises";
import { join } from "node:path";
import {
  adjudicate,
  DerivedFactsSchema,
  HarvestSchema,
  TaskEnvelopeSchema,
  type DerivedFacts,
  type Harvest,
  type HarvestStatus,
  type TaskEnvelope,
  type Verdict,
} from "../contracts.ts";
import { workerOutboxDir, workerPaths, taskRecordPath, type RunPaths } from "../run/paths.ts";
import { readTaskRecord, readWorkerState } from "../run/state.ts";
import { deriveGitFacts, type GitFacts } from "./git.ts";
import {
  readResultEnvelope,
  scanOutboxFiles,
  type OutboxLocation,
  type OutboxRead,
} from "./outbox.ts";

export interface HarvestOptions {
  /** Attach the full diff text to `derived.diff` (`--include diff`, §8.4). */
  includeDiff?: boolean;
}

export interface TaskHarvest {
  /** Validates against HarvestSchema by construction (ISC-88). */
  harvest: Harvest;
  /** The replayable fact bundle (ISC-153); E3 fields sit at schema defaults. */
  facts: DerivedFacts;
  harvestStatus: HarvestStatus;
}

/**
 * Verdict derivable from the repository alone, before acceptance execution
 * exists (E3 refines this with ISC-148..150 evidence).
 *
 * The deliberate asymmetry: an empty diff with no commits derives `failed` —
 * §7.2 is explicit that claimed success over nothing is failure — but a
 * NON-empty diff derives `unknown`, not `success`. The repository proves work
 * happened; only acceptance commands prove it is the RIGHT work, so upgrading
 * here would hand out successes this phase cannot yet justify.
 */
function deriveRepoVerdict(git: GitFacts): Verdict {
  if (!git.ok) return "unknown";
  if (git.facts.base_ref === null) return "unknown";
  // ISC-151: a rewritten base makes the diff meaningless. `unknown`, not
  // `failed` — the worker may have done real work; we simply cannot measure it.
  if (!git.facts.base_is_ancestor) return "unknown";
  if (git.facts.commits.length === 0 && git.facts.files_changed.length === 0) return "failed";
  return "unknown";
}

/**
 * F5 — self-report disagrees with the diff (SRD §8.2, §13). Claiming a file
 * the diff does not contain is the lying direction and is a hard failure
 * class; the derived diff naming files the envelope omitted is recorded but
 * does not floor the verdict — under-reporting is sloppy, not falsifying.
 */
function fileClaimDiscrepancies(
  claimed: readonly { path: string }[],
  derived: readonly { path: string }[],
): { hard: string[]; soft: string[] } {
  const derivedSet = new Set(derived.map((f) => f.path));
  const claimedSet = new Set(claimed.map((f) => f.path));
  const hard = [...claimedSet]
    .filter((p) => !derivedSet.has(p))
    .map((p) => `claimed change to ${p}, which the diff does not contain (F5)`);
  const soft = [...derivedSet]
    .filter((p) => !claimedSet.has(p))
    .map((p) => `diff contains ${p}, which the envelope did not claim`);
  return { hard, soft };
}

/** A harvest for a task the run has no dispatch record for. */
function unavailableHarvest(taskId: string, reason: string): TaskHarvest {
  const facts = DerivedFactsSchema.parse({
    branch: null,
    base_ref: null,
    head_ref: null,
    base_is_ancestor: false,
    harness: {},
  });
  return {
    harvest: HarvestSchema.parse({
      schema: "pifleet.artifacts/v1",
      task_id: taskId,
      worker: "unknown",
      epoch: 0,
      verdict: "unknown",
      reasons: [reason],
      claimed: null,
      derived: {
        branch: null,
        base_ref: null,
        commits: [],
        files_changed: [],
        diff: null,
        acceptance: [],
      },
      discrepancies: [],
      session_path: null,
    }),
    facts,
    harvestStatus: "unavailable",
  };
}

/** Harvest one task: A1 + A2, adjudicated (SRD §8.4). */
export async function harvestTask(
  run: RunPaths,
  taskId: string,
  opts: HarvestOptions = {},
): Promise<TaskHarvest> {
  // The inbox record is the durable dispatch envelope with the ASSIGNED epoch
  // (§7.1) — it tells the harvester which worker, worktree, base and epoch
  // this task is graded against. Without it there is nothing to grade against,
  // and guessing (say, scanning every outbox) would attribute artifacts by
  // coincidence of naming.
  const inboxPath = join(run.inboxDir, `${taskId}.json`);
  let envelope: TaskEnvelope;
  try {
    const raw = (await Bun.file(inboxPath).json()) as unknown;
    envelope = TaskEnvelopeSchema.parse(raw);
  } catch {
    return unavailableHarvest(taskId, `no dispatch record at inbox/${taskId}.json`);
  }

  const reasons: string[] = [];
  const discrepancies: string[] = [];

  // --- A2: the repository, authoritative (§8.2). Evidence considered first.
  const hasWorktree = envelope.host_workdir !== "unset" && envelope.host_workdir !== "";
  const git: GitFacts = hasWorktree
    ? await deriveGitFacts(envelope.host_workdir, envelope.base_ref)
    : {
        facts: DerivedFactsSchema.parse({
          branch: null,
          base_ref: null,
          head_ref: null,
          base_is_ancestor: false,
          harness: {},
        }),
        diffText: null,
        ok: false,
        reasons: ["task has no host_workdir; repository facts unavailable"],
      };
  reasons.push(...git.reasons);

  // --- A1: the envelope, advisory and untrusted (§7.2, §12.5).
  const loc: OutboxLocation = {
    workerOutboxDir: workerOutboxDir(run.root, envelope.worker),
    taskId,
    epoch: envelope.epoch,
    containerWorkdir: envelope.container_workdir,
    hostWorkdir: hasWorktree ? envelope.host_workdir : null,
  };
  const outbox: OutboxRead = await readResultEnvelope(loc);
  if (outbox.kind === "refused") {
    reasons.push(`result envelope refused: ${outbox.reason}`);
    discrepancies.push(`result envelope refused: ${outbox.reason}`);
  } else if (outbox.kind === "missing") {
    // Not a failure (ISC-94): the repo facts stand on their own.
    reasons.push("no result envelope; verdict rests on derived facts alone");
  }

  const scan = await scanOutboxFiles(loc);
  for (const r of scan.refused) {
    reasons.push(`outbox file refused: ${r.path}: ${r.reason}`);
    discrepancies.push(`outbox file refused: ${r.path}: ${r.reason}`);
  }

  // --- Adjudication (§7.3). Supervisor-terminal verdicts enter on the
  // derived side because `adjudicate` lets them win outright — a task the
  // supervisor aborted must not be reported by what its half-finished diff
  // happens to look like.
  let derivedVerdict = deriveRepoVerdict(git);
  const record = await readTaskRecord(taskRecordPath(workerPaths(run, envelope.worker), taskId));
  if (record !== null && record.epoch === envelope.epoch) {
    if (record.verdict === "aborted" || record.verdict === "timed_out") {
      derivedVerdict = record.verdict;
      reasons.push(`supervisor settled epoch ${record.epoch} as ${record.verdict}`);
    }
  }

  let f5 = false;
  if (outbox.kind === "ok" && git.ok && git.facts.base_is_ancestor) {
    const d = fileClaimDiscrepancies(outbox.envelope.files_changed, git.facts.files_changed);
    discrepancies.push(...d.hard, ...d.soft);
    f5 = d.hard.length > 0;
    if (
      outbox.envelope.branch !== undefined &&
      git.facts.branch !== null &&
      outbox.envelope.branch !== git.facts.branch
    ) {
      discrepancies.push(
        `envelope names branch ${outbox.envelope.branch}; worktree is on ${git.facts.branch}`,
      );
    }
  }

  const claimed = outbox.kind === "ok" ? outbox.envelope : null;
  let verdict = adjudicate(derivedVerdict, claimed?.status);
  if (f5 && verdict !== "aborted" && verdict !== "timed_out") {
    // Hard failure class (F5): a self-report contradicted by the diff means
    // the claims are not testimony but noise, and the §13 table pins the
    // response — failure, at the top of the report.
    verdict = "failed";
    reasons.push("verdict forced to failed: files_changed contradicts the diff (F5)");
  }

  // --- Harvest trustworthiness (§8.4), orthogonal to the verdict.
  const envelopeDegraded = outbox.kind === "refused" || scan.refused.length > 0;
  const harvestStatus: HarvestStatus =
    !git.ok && outbox.kind !== "ok"
      ? "unavailable"
      : git.ok && !envelopeDegraded
        ? "complete"
        : "partial";

  const state = await readWorkerState(workerPaths(run, envelope.worker)).catch(() => null);

  const harvest = HarvestSchema.parse({
    schema: "pifleet.artifacts/v1",
    task_id: taskId,
    worker: envelope.worker,
    epoch: envelope.epoch,
    verdict,
    reasons,
    claimed,
    derived: {
      branch: git.facts.branch,
      base_ref: git.facts.base_ref,
      commits: git.facts.commits,
      files_changed: git.facts.files_changed,
      diff: opts.includeDiff === true ? git.diffText : null,
      // E3's surface (ISC-148..150): stays empty until acceptance execution.
      acceptance: [],
    },
    discrepancies,
    session_path: state?.session_path ?? null,
  });

  return { harvest, facts: git.facts, harvestStatus };
}

/** Every dispatched task in the run — the single end-of-fanout call (§8.4). */
export async function harvestAll(run: RunPaths, opts: HarvestOptions = {}): Promise<TaskHarvest[]> {
  let entries: string[];
  try {
    entries = await readdir(run.inboxDir);
  } catch {
    return []; // a run with no dispatches has an empty, valid harvest
  }
  const taskIds = entries
    .filter((e) => e.endsWith(".json") && !e.startsWith("."))
    .map((e) => e.slice(0, -".json".length))
    .sort();
  const out: TaskHarvest[] = [];
  // Sequential on purpose: several tasks can share a worktree, and concurrent
  // `git` invocations against one worktree contend on the index lock (F23).
  //
  // Each task is isolated. Harvest reads worker-controlled files with a
  // filesystem underneath them, so a task CAN fail in a way no refusal path
  // anticipated — and an unguarded loop turns that into the loss of every
  // other task's harvest in the run, which is the §8.4 failure: `artifacts`
  // exits nonzero having emitted no JSON, and the healthy work is gone with
  // the poisoned task. One task that cannot be harvested is one task with
  // `harvest_status: "unavailable"`.
  for (const id of taskIds) {
    try {
      out.push(await harvestTask(run, id, opts));
    } catch (err) {
      out.push(unavailableHarvest(id, `harvest failed: ${String(err)}`));
    }
  }
  return out;
}
