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

import { readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { adjudicate as adjudicateFacts } from "./adjudicate.ts";
import { harnessSurfaceFor, resolveFromEnvelope, runAcceptance } from "./acceptance.ts";
import { gradedSurface } from "./resolution-surface.ts";
import { networkFromLaunchArgv } from "./acceptance-container.ts";
import { makeDaemonScratch } from "../container/mounts.ts";
import { Deadline } from "../util/clock.ts";
import {
  DerivedFactsSchema,
  HarvestSchema,
  TaskEnvelopeSchema,
  rank,
  type DerivedFacts,
  type Harvest,
  type HarvestStatus,
  type TaskEnvelope,
  type Verdict,
} from "../contracts.ts";
import { workerOutboxDir, workerPaths, taskRecordPath, type RunPaths } from "../run/paths.ts";
import { readTaskRecord, readWorkerLaunch, readWorkerState } from "../run/state.ts";
import { worktreeContentHash } from "../run/treehash.ts";
import { deriveGitFacts, type GitFacts } from "./git.ts";
import {
  readResultEnvelope,
  safeForReport,
  withOutboxScan,
  type OutboxLocation,
  type OutboxRead,
} from "./outbox.ts";
import { dispatchedTaskIds, unexplainedOutboxDirs } from "./layout.ts";
import { resolveWorkerNeedles } from "./needles.ts";
import { reconcileArtifactClaims } from "./reconcile.ts";

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
  /**
   * Scratch root for the fresh clone. Defaults to a DAEMON-VISIBLE root
   * (`makeDaemonScratch`), not the OS temp dir — see the call site for why
   * `os.tmpdir()` is the one path this must not be (ISC-277).
   *
   * A caller supplying its own is supplying one this module cannot vouch for,
   * which is why `runAcceptance` probes rather than trusts: the containerized
   * path reads a host-written sentinel back from inside the container before
   * it grades anything, and an unshared root yields `not_run` instead of a
   * green exam against an empty directory.
   */
  acceptanceScratch?: string;
  /** Whole-run budget for acceptance execution. */
  acceptanceBudgetMs?: number;
  /** Per-command ceiling, itself bounded by the run budget. */
  acceptancePerCommandMs?: number;
  /**
   * Secret VALUES to sweep a ticket-ops artifact for, as literal needles — an
   * OVERRIDE, not the supply.
   *
   * ## What changed, and why the old default was the bug
   *
   * This used to be the only way needles could ever arrive, and no production
   * caller passed any: `artifacts`, `report` and `harvestAll` all left it
   * unset, so `findCredentialLeaks` swept an empty list and could not fire.
   * That is ISC-333, and it is worse than an unimplemented check — the
   * mechanism was present, tested and invoked, so the harvest reported a clean
   * sweep of nothing and read as coverage. A worker echoed its credential and
   * this said nothing.
   *
   * The needles now come from the run itself when this is `undefined`: the
   * grant `up` recorded in the worker's launch record, valued from the 0600
   * env file `up` wrote beside it (`harvest/needles.ts`). Scoped to what THIS
   * worker was actually granted — never a scan of the host environment, and
   * never re-derived from a `fleet.yaml` in the harvester's cwd, which
   * `harvest/patterns.ts` forbids for a reason that applies here identically.
   *
   * ## When to set it
   *
   * A caller that legitimately holds values the run does not — a probe, or a
   * harvest of a run assembled by hand — supplies them here and REPLACES the
   * run's supply rather than adding to it, so a test can also pin the sweep to
   * exactly nothing by passing `[]`. The schema's own credential-hygiene rules
   * (an unelided `Authorization` header, a token-bearing query parameter) need
   * no needles and run either way.
   */
  secrets?: readonly string[];
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
    /**
     * AND IT IS A DISCREPANCY, which is the part that was missing.
     *
     * The line above is not new and it is not enough. `reasons` is where the
     * harvest explains HOW it reached its verdict — every entry there is
     * procedural, most are benign, and "verdict rests on derived facts alone"
     * reads like one of the benign ones. `discrepancies` is the channel §8.4
     * publishes for things that DISAGREE with the contract, and it is the one
     * an operator scans. A dispatched task with no envelope was visible only in
     * the first, phrased as a routine note, so a worker that never wrote its
     * result produced a report indistinguishable from a worker that did.
     *
     * MEASURED: a live worker completed a task, wrote no `result.json`
     * anywhere, and its output was accepted with no complaint. Nothing in the
     * harvest was wrong; nothing in it said this either.
     *
     * NO CLAMP, and the restraint is ISC-94's, not timidity. A missing envelope
     * is explicitly not a failure — a worker can be killed after committing
     * real work, and the diff still speaks for it. Clamping here would convert
     * every crash-after-commit into `failed` on evidence that says nothing
     * about the work, which is a worse report than the silence it replaces. The
     * defect was never a missing verdict; it was a missing STATEMENT.
     *
     * The CONTAINER spelling of the path, not the host one. It is the path the
     * worker was given in its brief and the only one it could have written to,
     * so it is the string an operator compares against what the worker
     * actually did.
     */
    discrepancies.push(
      `dispatched task ${safeForReport(taskId)} has no result envelope at ` +
        `/outbox/${safeForReport(taskId)}/result.json; the worker's own account of what it did ` +
        `is absent, so nothing it claims was checked`,
    );
  }

  /**
   * THE OUTBOX'S LAYOUT, checked against what was dispatched.
   *
   * Everything below this line reads `<outbox>/<task-id>/`, and until now
   * nothing asked whether the worker had put anything there. A worker that
   * writes to a directory of its own naming produces an empty region, an empty
   * scan, an empty reconciliation and a clean report — the harvest is correct
   * at every step and says nothing at all. `harvest/layout.ts` carries the
   * measurement.
   *
   * NOT A CLAMP, and this is the one place the three new findings are graded
   * differently from each other, so the reasoning is worth stating here rather
   * than only in the module.
   *
   * An unexplained directory is a fact about the WORKER's outbox, and the
   * harvest cannot attribute it to any task — that is precisely what makes it
   * unexplained. One worker serves many tasks, so clamping on it would lower
   * the verdict of every task that worker ran, including the ones whose own
   * output was complete and correct, on evidence that names none of them. The
   * unpaired `ticket-ops.md` clamp in `reconcile.ts` is attributable — the file
   * is inside this task's own `files/` — and that difference is the whole
   * reason one clamps and this does not.
   *
   * It is also not, on its own, evidence that the work failed. The diff is
   * still there and still speaks for what happened; what is lost is the
   * artifact, and the finding says so in the terms that matter: nothing inside
   * that directory was scanned, validated, or swept for credentials.
   */
  discrepancies.push(...(await unexplainedOutboxDirs(run, envelope.worker)));

  /**
   * From here to the end of the function, this scan is THIS function's to own.
   *
   * (The field's dotted spelling is deliberately not written out anywhere in
   * this file: ISC-246's claim greps `src/` for it to prove the descriptor
   * work still has no production consumer, and prose that spells it would
   * fail that claim from a comment. The same collision, in the opposite
   * direction, is recorded under ISC-300.)
   *
   * Every ACCEPTED entry of the scan is holding an OPEN DESCRIPTOR — that is the
   * documented contract at `OutboxFile` ("THE CALLER OWNS IT AND MUST CLOSE
   * IT"), and `closeOutboxScan` is the only thing that gives those descriptors
   * back. There is no finalizer behind it: a scan dropped without closing
   * leaks one descriptor per accepted artifact, silently, for the life of the
   * process.
   *
   * WHY THE `finally`, AND NOT A CLOSE AFTER THE `refused` LOOP BELOW. Today
   * nothing in this function reads the scan's accepted list; only its refusals are
   * consumed, three lines down. Closing immediately after that loop would
   * therefore release the descriptors and pass every test that exists. It is
   * still the wrong shape, because it would make this function's ownership
   * window NARROWER THAN THE CONTRACT `OutboxFile` documents. The descriptors
   * exist precisely so a consumer can read validated bytes DURING this task's
   * processing — that is the entire reason `scanOutboxFiles` hands back
   * handles instead of paths: a path is a NAME, re-resolved on every use, so
   * whatever `realpath` and `nlink` proved at scan time would have to be taken
   * on trust at read time; a held descriptor pins the inode that passed the
   * checks. An early close would put the release BEFORE the adjudication that
   * a future consumer of those bytes would naturally sit inside, so the first
   * such consumer would find itself reading through a closed handle and would
   * have to relocate the close as part of its own change. The `finally` keeps
   * the window correct for the whole body — today, when it is only `refused`
   * that is read, and later, when it is not.
   *
   * WHY THIS IS NOT OPTIONAL HOUSEKEEPING. `MAX_HELD_DESCRIPTORS` is 128
   * because that is "half of that 256 floor, so the scan leaves headroom for
   * the rest of the process" — and that bound is PER SCAN. Nothing releases
   * descriptors BETWEEN scans. `harvestAll` below loops this function over
   * every task in the run, and `report/collect.ts` and
   * `cli/commands/artifacts.ts` do the same, one call per task. Without the
   * release below, two tasks with full outboxes reach 256 held descriptors and
   * exhaust the very soft limit the cap was sized against — the cap's own
   * stated rationale defeated not by a scan that exceeded it, but by scans
   * that each stayed under it and never handed anything back.
   */
  /*
   * The scan is owned by this call and released when it ends, whichever way
   * it ends. `withOutboxScan` is what makes that structural rather than a
   * `finally` somebody has to remember to write; see its docstring for what
   * the hand-written version could not be shown to do.
   */
  return await withOutboxScan(loc, async (scan) => {
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

    /**
     * THE CREDENTIAL SWEEP'S NEEDLES (ISC-333).
     *
     * `opts.secrets` still wins when a caller supplies it — that is the escape
     * hatch `HarvestOptions` documents, and a caller that legitimately holds
     * the values is entitled to say so. What changed is the DEFAULT: it was
     * `[]` at every production call site, so the sweep ran over an empty
     * needle set and could never hit, and the mechanism read as coverage while
     * detecting nothing.
     *
     * Resolved HERE rather than in `reconcile.ts`, and that placement is a
     * hard constraint rather than taste. That module imports no filesystem API
     * at all — only `node:crypto`, `node:path`, `zod` and two local modules —
     * and reads solely through descriptors the scan already holds. The
     * structural absence of an `open` is what makes its §12.5 anti-exfiltration
     * argument checkable, and ISC-246's registered claim asserts it. A supplier
     * that reached the filesystem from inside the reconciler would trade a
     * guarantee for a feature.
     *
     * So the values arrive as an argument, from the function that is already
     * holding the run directory and the worker id, and the reconciler stays a
     * pure function of a scan, a claim list, and a needle list.
     */
    const supply =
      opts.secrets === undefined
        ? await resolveWorkerNeedles(workerPaths(run, envelope.worker))
        : { needles: [...opts.secrets], names: [], note: null };
    if (supply.note !== null) reasons.push(supply.note);

    /**
     * THE OUTBOX'S ARTIFACTS, RECONCILED AGAINST WHAT THE ENVELOPE CLAIMED.
     *
     * This is the first thing in `src/` that reads outbox artifact CONTENT at
     * all. Until now the scan's accepted entries were opened, validated and
     * handed back, and the only half of the result anything consumed was its
     * refusals — so a worker could name an artifact it never wrote, or write
     * one it never named, and the harvest had no opinion either way.
     *
     * WHY IT IS INSIDE THIS BLOCK AND NOT AFTER IT. The reconciler reads
     * through the descriptors the scan is holding, and those descriptors are
     * alive only for the duration of this body — `withOutboxScan` hands them
     * back in its `finally`. This call site is exactly the "consumer that reads
     * validated bytes DURING this task's processing" the ownership window above
     * was deliberately kept wide for. It is not a coincidence that it fits; the
     * window was shaped for it.
     *
     * WHAT IT IS NOT ALLOWED TO DO, and the reason the reconciler owns the
     * comparison rather than this function: a claimed path is worker-authored
     * and §12.5 calls dereferencing one an exfiltration primitive. Nothing here
     * or there opens a claimed path. Claims are translated through the mount
     * table and matched AS STRINGS against host paths the scan already
     * validated; bytes come only from the held descriptors.
     *
     * The findings go into `discrepancies` — the channel §8.4 already
     * publishes — and the digested inventory goes into `derived.artifacts`,
     * assembled below.
     *
     * PUBLISHING THE INVENTORY IS THE POINT, and this comment used to argue
     * the opposite: that inventing a `Harvest` field before something read it
     * would repeat the adjudicator's "tested mechanism with no live call site"
     * mistake. That reasoning does not transfer, and ISC-153 is the closer
     * precedent. `facts_hash` was computed and dropped on the floor, "which
     * satisfies neither half of what it is for" — because for a CONTENT HASH
     * the field IS the consumer. Identifying the evidence is the entire use:
     * an operator disputing a verdict needs to know whether the bytes have
     * changed since, and a report that says which artifacts a worker produced
     * while unable to say what they were is materially weaker than one that
     * can. The adjudicator's defect was a computation nothing INVOKED; this
     * would have been a measurement nothing RECORDED, which is the ISC-153
     * defect rather than that one.
     */
    const reconciled = await reconcileArtifactClaims(scan, claimed?.artifacts ?? null, loc, {
      secrets: supply.needles,
    });
    discrepancies.push(...reconciled.discrepancies);

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
      /**
       * ISC-277: the scratch root moves off `os.tmpdir()`.
       *
       * It was `mkdtemp(join(tmpdir(), "pifleet-accept-"))` — literally the path
       * `container/mounts.ts:51` marks "Deliberately NOT `os.tmpdir()`", in the
       * table it measured on this machine, next to the words "not shared,
       * silently empty". That was harmless for as long as nothing mounted it,
       * and it becomes a false PASS the moment something does: an unshared path
       * bind-mounts as an empty directory, the exam finds no tests to fail, and
       * a worker that changed nothing is certified. `makeDaemonScratch` is the
       * existing answer — it allocates under `$HOME/.pifleet/scratch`,
       * overridable with `PIFLEET_SCRATCH_DIR`, and opens the mode for the
       * baked worker uid.
       *
       * The move is made even on the HOST path (no container in reach), rather
       * than only when containerizing. A scratch root whose visibility depends
       * on which branch the harvester happens to take is a root that is right by
       * coincidence, and `runAcceptance`'s probe would then be asserting a
       * property the caller could withdraw.
       */
      const ownScratch = opts.acceptanceScratch === undefined;
      const scratchRoot = opts.acceptanceScratch ?? (await makeDaemonScratch("accept"));

      /**
       * ISC-233: which image graded the code, taken from what the run RECORDED.
       *
       * `launch.json` already carries the tag the supervisor actually spawned —
       * `WorkerLaunchSchema.image`, written by `materializeWorkerInputs` — so no
       * new persistence is needed and, more to the point, no second derivation
       * exists to disagree with the first. That matters here for the same reason
       * `up`'s image gate gives about taking its tags from `renderAllWorkers`
       * rather than calling `imageTag` again: a grader that recomputed the tag
       * could certify an image the run never used.
       *
       * `null` is a real answer, not a degraded one. It means the run had no
       * container at all — `PIFLEET_PI_COMMAND`, which is how this repo's entire
       * e2e and integration suite runs — so there is no image to hold the exam
       * in and the host path is the only honest option. `readWorkerLaunch`
       * returns exactly that, and the supervisor already branches on it.
       */
      const launch = await readWorkerLaunch(workerPaths(run, envelope.worker));
      try {
        const result = await runAcceptance({
          repo: envelope.host_workdir,
          head_sha: git.facts.head_ref,
          scratch_dir: scratchRoot,
          commands: resolveFromEnvelope([...envelope.acceptance], envelope.base_ref),
          deadline: new Deadline(opts.acceptanceBudgetMs ?? 600_000),
          per_command_timeout_ms: opts.acceptancePerCommandMs ?? 120_000,
          container:
            launch === null
              ? undefined
              : { image: launch.image, network: networkFromLaunchArgv(launch.argv) },
        });
        factsWithHarness.acceptance = result.runs;
        factsWithHarness.acceptance_context = result.context;
      } catch (err) {
        // An exam that could not be held is not an exam the worker failed
        // (ISC-152). Recorded as a reason so the verdict stays uncertifiable.
        reasons.push(`acceptance could not be run: ${String(err)}`);
      } finally {
        /**
         * Remove the scratch root, and ONLY one this function allocated.
         *
         * The leak predates this change — nothing ever removed the old
         * `mkdtemp(tmpdir())` root either — but it was survivable there because
         * the OS reaps its temp directory. Moving to `$HOME/.pifleet/scratch`
         * for ISC-277 makes the same leak DURABLE: every `artifacts
         * --run-acceptance` would leave a full clone of the repository behind
         * forever, under the operator's home directory, and this feature's own
         * test run left six of them in a single afternoon.
         *
         * `ownScratch` is the whole condition. A caller that supplied
         * `acceptanceScratch` owns that directory — it is a fixture root in the
         * suite and could be a directory an operator cares about — and deleting
         * it would be tidying someone else's state rather than cleaning up after
         * this function.
         *
         * Failures are swallowed. The harvest result is already assembled; a
         * cleanup error must not replace a real verdict with a housekeeping one.
         */
        if (ownScratch) await rm(scratchRoot, { recursive: true, force: true }).catch(() => {});
      }
    }

    /**
     * ISC-243: the graded resolution surface, keyed on the commands that ran.
     *
     * Computed HERE rather than beside `harnessSurfaceFor` above because it
     * needs an input that does not exist yet up there: the resolved acceptance
     * commands. That ordering is not an inconvenience to work around — it is the
     * whole difference between the two mechanisms. The denylist is a fixed list
     * applied to any diff from no input; the allowlist is keyed on WHICH RUNNER
     * graded the code, which is knowable only once the exam has been held.
     *
     * Driven off `factsWithHarness.acceptance` rather than off the `try` block's
     * local `result`, so an exam whose runs arrived by any other route is graded
     * the same way. No runs means no runner, which means an empty graded surface
     * and the denylist alone — exactly today's behaviour, and the honest answer
     * when nothing was executed.
     */
    {
      const surface = gradedSurface(
        factsWithHarness.acceptance.map((r) => r.cmd),
        factsWithHarness.files_changed.map((f) => f.path),
      );
      factsWithHarness.harness = {
        ...factsWithHarness.harness,
        graded: surface.hits.map((h) => ({ file: h.file, tier: h.tier, why: h.why })),
        graded_runners: [...surface.runners],
        graded_unresolved: [...surface.unresolved],
      };
    }

    /**
     * ISC-154: the two worktree hashes, and the reason they are two.
     *
     * The check is "did the tree move between quiesce and harvest end", and it
     * only means anything if the two samples are taken at genuinely different
     * moments by genuinely different code. They are:
     *
     *   - QUIESCE is sampled by the SUPERVISOR, inside `settle`, in a different
     *     process, at the instant it declares the epoch over. It survives to
     *     here only because it was written into the task record — the same
     *     durable channel this function already reads supervisor-terminal
     *     verdicts from a few lines above.
     *   - HARVEST END is sampled HERE, last, after the diff has been derived
     *     and after any acceptance exam has been held. Deliberately the final
     *     measurement in the function: sampling it earlier would leave a window
     *     at the end of harvest that the check is blind to, which is precisely
     *     the window a backgrounded writer occupies.
     *
     * Had both been taken by this function they would be two calls microseconds
     * apart against one tree, always equal, and the criterion would be closed
     * by a comparison that cannot fail.
     *
     * The quiesce hash is accepted ONLY from a record matching this envelope's
     * epoch. A record from a different epoch describes a different dispatch of
     * this task; comparing its tree against today's harvest would void the task
     * for the entirely legitimate act of having been retried.
     */
    factsWithHarness.tree_hash_quiesce =
      record !== null && record.epoch === envelope.epoch ? record.tree_hash : null;
    factsWithHarness.tree_hash_harvest = hasWorktree
      ? await worktreeContentHash(envelope.host_workdir)
      : null;

    const adj = adjudicateFacts(factsWithHarness, claimed);
    let verdict = adj.verdict;
    reasons.push(...adj.reasons);
    discrepancies.push(...adj.discrepancies);

    /**
     * ISC-332: a ticket-ops artifact that failed validation caps the verdict.
     *
     * WHY HERE AND NOT IN `adjudicate`. The adjudicator is handed derived facts
     * and a claim; it never sees a descriptor, so artifact CONTENT is the one
     * class of evidence it structurally cannot weigh. Pushing the finding into
     * `discrepancies` alone would have left a ticketing task returning
     * `success` with "this artifact is malformed" printed underneath it — the
     * criterion's "surprise at read time", relocated rather than removed.
     *
     * WHY IT IS A CLAMP AND NOT AN ASSIGNMENT. `rank("unknown")` is -1, below
     * every gradeable verdict, so a harvest that already refused to certify —
     * ISC-154's voided tree, ISC-151's rewritten base — is left exactly as it
     * was. Nothing is weighed on top of voided evidence, and a bad artifact
     * cannot promote `unknown` into the more definite-sounding `failed`.
     *
     * WHY BEFORE THE SUPERVISOR OVERRIDE. `aborted` and `timed_out` are facts
     * about the RUN and must still win: a task killed at its deadline is
     * reported as killed, not as having written a bad artifact.
     */
    if (reconciled.verdictCeiling !== null && rank(verdict) > rank(reconciled.verdictCeiling)) {
      verdict = reconciled.verdictCeiling;
      /**
       * THE REASON COMES FROM THE RECONCILER, not from this line.
       *
       * It used to be one fixed sentence, and that was correct while a failed
       * schema parse was the only thing that could raise the ceiling. There is
       * now a second cause — a `ticket-ops.md` written with no
       * `ticket-ops.json` beside it, so nothing validated and nothing swept —
       * and "failed validation" is FALSE of it: no document was parsed,
       * nothing failed, and an operator told otherwise goes looking for a
       * malformed file that does not exist. Two causes sharing one sentence is
       * a report misdescribing its own evidence, so the cause now travels with
       * the ceiling and this site prints what it was handed.
       *
       * The `??` is unreachable by construction — `clampTo` sets both fields
       * together and neither is settable alone — and it is here so that a
       * future edit which breaks that pairing degrades to a vague reason
       * rather than to `undefined` in an operator's report.
       */
      reasons.push(
        reconciled.verdictCeilingReason ??
          `an artifact in the outbox capped this task's verdict at ${reconciled.verdictCeiling}`,
      );
    }

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
        /**
         * The outbox's own artifacts, digested from the descriptors the scan
         * held — passed through unchanged rather than re-projected.
         *
         * `acceptance` above is projected because the adjudicator reads a
         * richer shape than the report publishes. There is no such second
         * shape here: `HarvestedArtifactSchema` and `ReconciledArtifact` are
         * the same three fields, and mapping between them would only create a
         * place for them to drift apart.
         */
        artifacts: reconciled.artifacts,
      },
      discrepancies,
      session_path: state?.session_path ?? null,
      facts_hash: adj.facts_hash,
    });

    // The returned facts are the ones the verdict was actually reached from —
    // harness surface included. Returning `git.facts` here would hand callers a
    // bundle whose hash does not match the `facts_hash` beside it.
    return { harvest, facts: factsWithHarness, harvestStatus };
  });
}

/** Every dispatched task in the run — the single end-of-fanout call (§8.4). */
export async function harvestAll(run: RunPaths, opts: HarvestOptions = {}): Promise<TaskHarvest[]> {
  /*
   * The dispatched set comes from `harvest/layout.ts`, which is also what the
   * unexplained-directory check compares outbox directory names against. ONE
   * function answers "which tasks did this run dispatch", for the reason
   * ISC-345 states: two readers of one fact, written independently, is how one
   * of them goes blind while the other keeps working. Here the drift would be
   * silent in the worst direction — a task this loop harvested but that
   * function did not recognise would be reported as an unexplained directory
   * on every sibling task's harvest, forever, for having been dispatched
   * normally.
   *
   * An unreadable inbox still yields an empty list, so a run with no
   * dispatches still has an empty, valid harvest.
   */
  const taskIds = await dispatchedTaskIds(run);
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
