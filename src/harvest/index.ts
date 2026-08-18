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

import { mkdtemp, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { adjudicate as adjudicateFacts } from "./adjudicate.ts";
import { harnessSurfaceFor, resolveFromEnvelope, runAcceptance } from "./acceptance.ts";
import { Deadline } from "../util/clock.ts";
import {
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
  /**
   * Re-run the task's acceptance commands and grade on the result (§8.2).
   *
   * OFF by default, and the default is the important part: `artifacts` is
   * documented as a pure read, and a read that silently executes commands
   * from the repository under inspection is a different command wearing the
   * same name. Opting in is the caller saying "spend time and run code".
   *
   * With it off, `derived.acceptance` is empty and the adjudicator has no
   * exam to weigh — which is why a real diff can only ever derive `unknown`
   * and the worker's own claim decides. That is the honest position when
   * nothing was verified, not a bug.
   */
  runAcceptance?: boolean;
  /**
   * Repo-relative globs that count as the test harness (ISC-232), from
   * `harness.patterns`. Absent means no opinion was recorded and
   * `DEFAULT_HARNESS_PATTERNS` applies; a present list REPLACES them. An
   * empty list is rejected, not rescued — see `harnessSurfaceFor`.
   *
   * Passed in rather than loaded here on purpose. Harvest is handed a RUN
   * directory, not a workspace, and a run routinely outlives the config that
   * produced it — a harvester that resolved `./fleet.yaml` itself would grade
   * an old run against whatever config happens to sit in today's cwd, which
   * is a worse failure than using the defaults.
   *
   * That rule constrains the CLI as much as this module, and `harvest/
   * patterns.ts` is where it is enforced: the value comes from the run
   * directory, written when the run was created, so re-harvesting a run
   * cannot pick up a `fleet.yaml` that appeared in the cwd afterwards. Cwd
   * and `~/.config` discovery reach `up`; they do not reach harvest.
   */
  harnessPatterns?: readonly string[];
  /** Scratch root for the fresh clone. Defaults to the OS temp dir. */
  acceptanceScratch?: string;
  /** Whole-run budget for acceptance execution. */
  acceptanceBudgetMs?: number;
  /** Per-command ceiling, itself bounded by the run budget. */
  acceptancePerCommandMs?: number;
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

  const claimed = outbox.kind === "ok" ? outbox.envelope : null;

  if (outbox.kind === "ok" && git.ok && git.facts.base_is_ancestor) {
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

  /**
   * Adjudication runs through `harvest/adjudicate.ts` — the module that owns
   * the evidence rules — not through the two-argument lattice combinator in
   * contracts.ts.
   *
   * This wiring is the point. The rich adjudicator, and every criterion it
   * implements (the ISC-150 harness cap, the ISC-153 replay hash, the ISC-154
   * moved-tree void, the ISC-230 inconclusive-exam cap), had a full passing
   * test suite and ZERO production callers: `artifacts` reached the lattice
   * combinator instead, so those criteria were satisfied only inside tests of
   * a module nothing ran. A tested mechanism with no live call site is
   * indistinguishable at runtime from one that was never written, and the
   * green suite is what made it look done.
   *
   * It also settles a contradiction between the two implementations of F5.
   * The version here treated under-claiming as "sloppy, not falsifying" and
   * only floored the verdict for over-claiming; SRD §880 says *disagreement*
   * between the envelope's `files_changed` and the diff is a hard failure
   * class, unqualified. The stricter module — which calls under-claiming
   * concealment — is the one that matches the spec, and now the one that runs.
   */
  /**
   * The harness surface is derived HERE, from the diff, before adjudication.
   *
   * It is computable from facts the harvester already holds — no acceptance
   * execution required — and leaving it at the schema default meant
   * `facts.harness.touched` was permanently empty, so the ISC-150 cap could
   * never fire no matter what the worker edited. The cap was live code
   * guarding a field nothing filled in.
   *
   * The changed-file list comes from the DERIVED diff, never from the
   * envelope: the envelope is the actor being graded, and a worker asked to
   * self-declare whether it touched the tests has an obvious answer.
   *
   * WHICH globs count is the caller's to say (ISC-232): `harness.patterns`
   * from `fleet.yaml` when the operator set it, and only otherwise the
   * built-in defaults.
   *
   * `harnessSurfaceFor` owns that fallback rather than a `??` here, and the
   * difference is not stylistic. `opts.harnessPatterns ?? DEFAULT_...` rescues
   * `undefined` and `null` but NOT `[]`, so every caller assembling
   * `HarvestOptions` by hand — a test, `report/collect.ts`, anything future —
   * could hand in an empty list and get `touched: []` with no error, which
   * disables the ISC-150 cap outright. The schema refuses `patterns: []` at
   * the YAML boundary; the in-process path needs the same stance, and it also
   * needs the wider check the config-aware helper performs, since a NON-empty
   * list that simply matches nothing disables the cap just as completely.
   */
  const factsWithHarness: DerivedFacts = {
    ...git.facts,
    harness: harnessSurfaceFor(
      git.facts.files_changed.map((f) => f.path),
      opts.harnessPatterns,
    ),
  };

  /**
   * The exam (§8.2): the harvester re-runs the acceptance commands itself.
   *
   * Commands are resolved from the BASE SHA, never from the worker's tree —
   * independence is a property of where the command is resolved from, not of
   * who runs it, because the command string routes through `package.json`
   * scripts, `conftest.py` and the Makefile, all of which the worker can
   * edit. The envelope's own `acceptance` array is a CLAIM and is never
   * executed; the task envelope's is the fleet-authored one.
   *
   * Requires a real head SHA and a worktree to clone from. Without either
   * there is nothing to examine, and the runs stay empty rather than being
   * filled with a guess.
   */
  if (opts.runAcceptance === true && git.ok && git.facts.head_ref !== null && hasWorktree) {
    const scratchRoot = opts.acceptanceScratch ?? (await mkdtemp(join(tmpdir(), "pifleet-accept-")));
    try {
      const result = await runAcceptance({
        repo: envelope.host_workdir,
        head_sha: git.facts.head_ref,
        scratch_dir: scratchRoot,
        commands: resolveFromEnvelope([...envelope.acceptance], envelope.base_ref),
        deadline: new Deadline(opts.acceptanceBudgetMs ?? 600_000),
        per_command_timeout_ms: opts.acceptancePerCommandMs ?? 120_000,
      });
      factsWithHarness.acceptance = result.runs;
      factsWithHarness.acceptance_context = result.context;
    } catch (err) {
      // An exam that could not be held is not an exam the worker failed
      // (ISC-152). Recorded as a reason so the verdict stays uncertifiable.
      reasons.push(`acceptance could not be run: ${String(err)}`);
    }
  }

  const adj = adjudicateFacts(factsWithHarness, claimed);
  let verdict = adj.verdict;
  reasons.push(...adj.reasons);
  discrepancies.push(...adj.discrepancies);

  // The supervisor's terminal verdicts outrank derived evidence: `aborted`
  // and `timed_out` are facts about the RUN, not inferences from the tree
  // (§7.3), and no amount of clean diff makes an aborted task complete.
  if (derivedVerdict === "aborted" || derivedVerdict === "timed_out") {
    verdict = derivedVerdict;
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
      /**
       * The harvester's OWN exam results, projected into the report's claim
       * shape (criterion / met / evidence). Empty unless `--run-acceptance`
       * asked for the exam to be held.
       *
       * `met` is true only for `passed`. A timed-out or unrun command is not
       * a met criterion and is not a failed one either (ISC-152) — the
       * distinction survives in `evidence`, and the verdict cap that acts on
       * it lives in the adjudicator, which reads the full runs rather than
       * this projection.
       */
      acceptance: factsWithHarness.acceptance.map((r) => ({
        criterion: r.cmd,
        met: r.outcome === "passed",
        evidence: `${r.outcome}${r.exit_code === null ? "" : ` (exit ${r.exit_code})`}`,
      })),
    },
    discrepancies,
    session_path: state?.session_path ?? null,
    facts_hash: adj.facts_hash,
  });

  // The returned facts are the ones the verdict was actually reached from —
  // harness surface included. Returning `git.facts` here would hand callers a
  // bundle whose hash does not match the `facts_hash` beside it.
  return { harvest, facts: factsWithHarness, harvestStatus };
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
