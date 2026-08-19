import type { Command } from "commander";
import { lstat } from "node:fs/promises";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import { latestRunId, runPaths, runsRoot } from "../../run/paths.ts";
import { readRunWorktrees } from "../../run/state.ts";
import { inspectCloneDirt, type WorkerWorktree } from "../../run/worktree.ts";

/**
 * Register `pifleet worktrees` (SRD §9.2/§10): what `git worktree list` used
 * to answer, before per-worker isolation stopped being `git worktree add`.
 *
 * That command answered one question — "what checkouts exist under this
 * repository, on what branch" — from the parent's own `.git`, because a
 * linked worktree is recorded THERE. A `git clone --no-hardlinks` checkout is
 * not: it is an independent repository with its own `.git`, has no entry in
 * the parent's worktree list, and `git worktree list` run against the parent
 * now reports exactly one worktree — the parent's own — regardless of how
 * many workers `up` created. An operator who typed the old habit would see
 * nothing and could reasonably read that as "no workers are running," which
 * is the wrong answer while a run is live. This command reads the same
 * record `dispatch` and `down --prune` already trust (`run/worktree.ts`'s
 * `WorkerWorktree`, via `readRunWorktrees`) rather than re-deriving anything
 * from git, for the reason `run/paths.ts` gives at its own header: a second
 * way to compute a fact that already has one owner is how the two drift.
 *
 * A pure read, like `status` and `artifacts`: it exits 0 whenever it emitted
 * a valid report, including one that lists dirty or missing checkouts. A
 * checkout holding uncommitted work is not a failure of THIS command — it is
 * exactly the fact an operator runs it to find, before reaching for
 * `down --prune` or `--force`.
 */
export function register(program: Command): void {
  program
    .command("worktrees")
    .description("List every worker's per-worker git checkout: branch, path, and whether it is clean")
    .option("--run <id>", "run id")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { run?: string; json?: boolean }) => {
      const root = runsRoot();
      const runId = opts.run ?? (await latestRunId(root));
      if (runId === null) throw new CliError("no runs found", EXIT.USAGE);
      const run = runPaths(runId, root);

      const recorded = await readRunWorktrees(run);

      const rows: Array<{
        wt: WorkerWorktree;
        present: boolean;
        dirty: boolean | null;
        statusLines: number | null;
        commitsAhead: number | null;
        unreadable: string | null;
      }> = [];
      for (const wt of [...recorded.byWorker.values()].sort((a, b) => a.workerId.localeCompare(b.workerId))) {
        let present = true;
        try {
          await lstat(wt.path);
        } catch {
          present = false;
        }
        if (!present) {
          rows.push({ wt, present, dirty: null, statusLines: null, commitsAhead: null, unreadable: null });
          continue;
        }
        try {
          const dirt = await inspectCloneDirt(wt);
          rows.push({
            wt,
            present,
            dirty: dirt.dirty,
            statusLines: dirt.statusLines,
            commitsAhead: dirt.commitsAhead,
            unreadable: null,
          });
        } catch (err) {
          // A checkout that exists but cannot be inspected (permissions, a
          // corrupted .git) is reported rather than hidden — the same
          // detected-vs-neutralized honesty `security/repo-hazards.ts`
          // insists on elsewhere in this codebase.
          rows.push({
            wt,
            present,
            dirty: null,
            statusLines: null,
            commitsAhead: null,
            unreadable: err instanceof Error ? err.message : String(err),
          });
        }
      }

      if (opts.json === true) {
        process.stdout.write(
          `${JSON.stringify({
            run_id: runId,
            repo: recorded.repo,
            note: recorded.note,
            worktrees: rows.map((r) => ({
              worker_id: r.wt.workerId,
              branch: r.wt.branch,
              path: r.wt.path,
              base_sha: r.wt.baseSha,
              remote_name: r.wt.remoteName,
              present: r.present,
              dirty: r.dirty,
              status_lines: r.statusLines,
              commits_ahead: r.commitsAhead,
              unreadable: r.unreadable,
            })),
          })}\n`,
        );
        return;
      }

      process.stdout.write(`run ${runId}\n`);
      if (recorded.repo !== null) process.stdout.write(`repo ${recorded.repo}\n`);
      if (recorded.note !== null) process.stdout.write(`  note: ${recorded.note}\n`);
      if (rows.length === 0) {
        process.stdout.write("  no per-worker checkouts recorded for this run\n");
        return;
      }
      for (const r of rows) {
        const base = r.wt.baseSha.slice(0, 12);
        let state: string;
        if (!r.present) {
          state = "MISSING (checkout not found on disk)";
        } else if (r.unreadable !== null) {
          state = `UNREADABLE (${r.unreadable})`;
        } else if (r.dirty === true) {
          state = `dirty (${r.statusLines} uncommitted path(s), ${r.commitsAhead} commit(s) ahead)`;
        } else {
          state = "clean";
        }
        process.stdout.write(
          `  ${r.wt.workerId}: ${r.wt.branch} base=${base} ${state}\n` + `    ${r.wt.path}\n`,
        );
      }
    });
}
