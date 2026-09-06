import type { Command } from "commander";
import { readFile } from "node:fs/promises";

import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths } from "../../run/paths.ts";
import { readRunWorktrees } from "../../run/state.ts";
import { readIntegrationRecord } from "../../run/pm-integration.ts";
import { confirmDispatchStarted, testerCloneCoversMerge } from "../../run/pm-guards.ts";

/**
 * The ProjectManager loop's two refusals, reachable from a shell.
 *
 * ## Why this exists at all, when the decisions are already a module
 *
 * `src/run/pm-guards.ts` holds both judgements as pure functions, and the unit
 * suite drives them with injected data. That is enough to prove the decisions
 * are RIGHT and not enough to make them happen: §0.2 of
 * `Docs/SRD-FLEET-PROJECT-MANAGER.md` puts the orchestrator in a Claude Code
 * session, whose only way to reach a TypeScript function is a process. A guard
 * nothing invokes is the defect ISC-564 was corrected for — a decision sitting
 * in a module beside the code that should call it, with a document asking a
 * reader to do it by hand instead.
 *
 * ## Exit status is the interface
 *
 * Both subcommands exit `SUCCESS` when the thing they guard is safe and
 * `PARTIAL` when it is not, so `&&` in the workflow's own shell lines is enough
 * to stop a phase from continuing over a refusal. The explanation goes to
 * stdout either way, because the operator reading it is the one who has to act
 * on it, and `--json` carries the same verdict for anything parsing.
 */
export function register(program: Command): void {
  const guard = program
    .command("pm-guard")
    .description("The ProjectManager loop's pre-flight refusals: did a dispatch start, is a tester's clone current");

  guard
    .command("dispatch-started")
    .description("Confirm from `status` — never from the dispatch payload — that a dispatched task actually started")
    .requiredOption("--worker <id>", "the worker the envelope was dispatched to")
    .requiredOption("--task <id>", "the task id the envelope declared")
    .requiredOption("--dispatch-output <path>", "file holding `dispatch --json` stdout, or - for stdin")
    .requiredOption("--status <path>", "file holding `status --json` stdout, or - for stdin")
    .option("--json", "emit machine-readable output")
    .action(
      async (opts: {
        worker: string;
        task: string;
        dispatchOutput: string;
        status: string;
        json?: boolean;
      }) => {
        /*
         * Both streams are taken as FILES rather than re-run here, and that is
         * the point of the subcommand rather than a limitation of it. The
         * failure this guards is a runner that discarded a non-zero exit and
         * returned "" — so the bytes the orchestrator actually received are the
         * evidence, and a guard that fetched its own fresh copy would be
         * auditing a different dispatch than the one that happened.
         */
        const verdict = confirmDispatchStarted({
          worker: opts.worker,
          taskId: opts.task,
          dispatchStdout: await slurp(opts.dispatchOutput),
          statusJson: await slurp(opts.status),
        });
        // `--json` always emits, because a parser needs the verdict either way.
        // The prose form does NOT repeat itself on a refusal: `CliError` writes
        // the same sentence to stderr on the way out, and a guard that says the
        // same thing twice reads like two problems.
        if (opts.json === true) process.stdout.write(`${JSON.stringify(verdict)}\n`);
        /*
         * THREE exits for three states, because two of them need different
         * actions from whoever reads them.
         *
         * `staged` gets `TIMEOUT` rather than `PARTIAL`: the envelope is fine,
         * the worker will pick it up, and the correct response is to look
         * again — not to fix anything. Giving it `PARTIAL` alongside a genuine
         * refusal would make the ordinary case of an attended dispatch
         * indistinguishable from a broken one, and a guard that reports normal
         * operation as a failure is a guard an operator learns to ignore.
         */
        if (verdict.state === "staged") throw new CliError(verdict.detail, EXIT.TIMEOUT);
        if (!verdict.started) throw new CliError(verdict.detail, EXIT.PARTIAL);
        if (opts.json !== true) process.stdout.write(`${verdict.detail}\n`);
      },
    );

  guard
    .command("tester-fresh")
    .description("Refuse a tester whose clone predates this phase's integration merge")
    .requiredOption("--worker <id>", "the tester seat about to be dispatched to")
    .requiredOption("--phase <n>", "the phase whose integration record names the merges")
    .option("--run <id>", "run id (default: the most recent)")
    .option("--repo <path>", "the operator's checkout holding the integration record", process.cwd())
    .option("--json", "emit machine-readable output")
    .action(
      async (opts: { worker: string; phase: string; run?: string; repo: string; json?: boolean }) => {
        const phase = Number.parseInt(opts.phase, 10);
        if (!Number.isInteger(phase) || phase < 1) {
          throw new CliError(`--phase must be a positive integer, got ${opts.phase}`, EXIT.USAGE);
        }

        const runId = opts.run ?? (await latestRunId());
        if (runId === null) throw new CliError("no runs found; pass --run", EXIT.USAGE);
        const worktrees = await readRunWorktrees(runPaths(runId));
        const clone = worktrees.byWorker.get(opts.worker);
        if (clone === undefined) {
          throw new CliError(
            `run ${runId} records no clone for ${opts.worker} — it holds ` +
              `${[...worktrees.byWorker.keys()].join(", ") || "none"}`,
            EXIT.USAGE,
          );
        }

        /*
         * Only rows that actually MERGED contribute. A worker refused for a
         * hazard, or whose merge failed, wrote nothing into the integration
         * branch — demanding a tester contain a commit that does not exist
         * would refuse every tester for the rest of the phase.
         */
        const record = await readIntegrationRecord(opts.repo, phase);
        const mergeCommits = record.workers
          .filter((w) => w.merged && w.merge_commit !== null)
          .map((w) => w.merge_commit as string);

        const contains = new Map<string, boolean>();
        for (const commit of mergeCommits) {
          contains.set(commit, await cloneContains(clone.path, commit));
        }

        const verdict = testerCloneCoversMerge(
          { worker: opts.worker, cloneBaseSha: clone.baseSha, mergeCommits },
          (commit) => contains.get(commit) === true,
        );
        if (opts.json === true) {
          process.stdout.write(`${JSON.stringify({ run_id: runId, phase, ...verdict })}\n`);
        }
        if (!verdict.fresh) throw new CliError(verdict.detail, EXIT.PARTIAL);
        if (opts.json !== true) process.stdout.write(`${verdict.detail}\n`);
      },
    );
}

/**
 * Whether `commit` is in this clone's history.
 *
 * Asked against `HEAD` rather than the recorded `baseSha`, because a worker
 * that has committed on top of its clone still contains everything the clone
 * was made from, and `baseSha` would answer for a checkout the worker has
 * since moved past.
 *
 * A non-zero exit is `false` and never an error, which covers the case that
 * matters most: a clone made BEFORE the merge does not have that object at
 * all, so `merge-base` fails rather than answering no. Both mean the same
 * thing to a tester — the work is not in this checkout — and treating the
 * missing-object case as a crash would refuse to give an answer exactly when
 * the answer is the alarming one.
 */
async function cloneContains(clonePath: string, commit: string): Promise<boolean> {
  const p = Bun.spawn(["git", "-C", clonePath, "merge-base", "--is-ancestor", commit, "HEAD"], {
    stdout: "ignore",
    stderr: "ignore",
  });
  return (await p.exited) === 0;
}

async function slurp(path: string): Promise<string> {
  if (path === "-") return await Bun.stdin.text();
  try {
    return await readFile(path, "utf8");
  } catch (err) {
    throw new CliError(
      `could not read ${path}: ${err instanceof Error ? err.message : String(err)}`,
      EXIT.USAGE,
    );
  }
}
