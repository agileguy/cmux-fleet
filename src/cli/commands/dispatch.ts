import type { Command } from "commander";
import { randomUUID } from "node:crypto";
import { CliError } from "../index.ts";
import { EXIT, TaskEnvelopeSchema, type TaskEnvelope } from "../../contracts.ts";
import { inboxTaskPath, latestRunId, runPaths, runsRoot } from "../../run/paths.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { writeJsonAtomic } from "../../util/jsonl.ts";
import { controlCall } from "../../supervisor/launch.ts";

/**
 * Register `pifleet dispatch` (SRD §10, §7.1).
 *
 * The supervisor — not this command — is the sole epoch allocator (SRD §7.5):
 * dispatch carries `(task_id, requested_epoch|null)` plus an attempt id and
 * the supervisor returns the assignment or a rejection. `accepted:true` means
 * ACCEPTED, not started: the prompt ack is immediate and a late failure can
 * still fail the epoch afterwards (ISC-86).
 *
 * The attempt id makes retries idempotent: a re-send of the same task file
 * (which may carry its own `attempt_id`) replays the original answer instead
 * of guessing between "someone else did it" and "I did it and lost the ack".
 */
export function register(program: Command): void {
  program
    .command("dispatch")
    .description("Send task envelopes to workers")
    .option("-w, --worker <id>", "worker id")
    .option("-t, --task <path>", "task envelope file, or - for stdin")
    .option("--run <id>", "run id")
    .option("--auto", "dispatch automatically across idle workers")
    .option("--tasks <path>", "task list for --auto")
    .option("--json", "emit machine-readable output")
    .action(
      async (opts: { worker?: string; task?: string; run?: string; auto?: boolean; json?: boolean }) => {
        if (opts.auto === true) {
          throw new CliError("dispatch --auto is a Phase 5 deliverable", EXIT.USAGE);
        }
        if (opts.worker === undefined || opts.task === undefined) {
          throw new CliError("dispatch requires --worker and --task", EXIT.USAGE);
        }
        const root = runsRoot();
        const runId = opts.run ?? (await latestRunId(root));
        if (runId === null) throw new CliError("no runs found", EXIT.USAGE);
        const run = runPaths(runId, root);

        const raw =
          opts.task === "-"
            ? await new Response(Bun.stdin.stream()).text()
            : await Bun.file(opts.task).text();
        let partial: Record<string, unknown>;
        try {
          partial = JSON.parse(raw) as Record<string, unknown>;
        } catch (err) {
          throw new CliError(`task file is not valid JSON: ${String(err)}`, EXIT.USAGE);
        }

        const taskId = typeof partial["task_id"] === "string" ? partial["task_id"] : "";
        if (taskId === "") throw new CliError("task file needs a task_id", EXIT.USAGE);
        const attemptId =
          typeof partial["attempt_id"] === "string" ? partial["attempt_id"] : randomUUID();
        // `epoch` is MANDATORY in the envelope schema, and 0 is documented as
        // the placeholder the supervisor replaces. Allocated epochs start at 1,
        // so 0 can never be a genuine re-dispatch request — treating it as one
        // rejected every hand-written envelope with `stale_epoch`, which is the
        // one value the schema forces an author to supply. Found by dispatching
        // a real task.
        const rawEpoch = partial["epoch"];
        const requestedEpoch =
          typeof rawEpoch === "number" && rawEpoch > 0 ? (rawEpoch as number) : null;

        // Fill the envelope; epoch 0 is a placeholder the supervisor replaces
        // with its allocation before anything durable records it.
        let envelope: TaskEnvelope;
        try {
          envelope = TaskEnvelopeSchema.parse({
            schema: "pifleet.task/v1",
            task_id: taskId,
            run_id: runId,
            epoch: requestedEpoch ?? 0,
            attempt: typeof partial["attempt"] === "number" ? partial["attempt"] : 1,
            worker: opts.worker,
            dispatched_at: new Date().toISOString(),
            title: partial["title"] ?? taskId,
            brief: partial["brief"] ?? "",
            repo: partial["repo"] ?? "unset",
            host_workdir: partial["host_workdir"] ?? "unset",
            container_workdir: partial["container_workdir"] ?? "/workspace",
            branch: partial["branch"] ?? `fleet/${runId}/${opts.worker}`,
            base_ref: partial["base_ref"] ?? "0".repeat(40),
            inputs: partial["inputs"] ?? [],
            acceptance: partial["acceptance"] ?? [],
            constraints: partial["constraints"] ?? [],
            outbox: partial["outbox"] ?? `/outbox/${taskId}`,
            cloud_allow: partial["cloud_allow"] ?? [],
            deadline_s: partial["deadline_s"] ?? 1500,
            depends_on: partial["depends_on"] ?? [],
          });
        } catch (err) {
          throw new CliError(`invalid task envelope: ${String(err)}`, EXIT.USAGE);
        }

        const ledger = new LedgerWriter(run, `cli-dispatch-${process.pid}`);
        let reply: Record<string, unknown>;
        try {
          reply = await controlCall(run, opts.worker, {
            cmd: "dispatch",
            envelope,
            attempt_id: attemptId,
            requested_epoch: requestedEpoch,
          });
        } catch (err) {
          throw new CliError(
            `worker ${opts.worker} is unreachable: ${String(err)}`,
            EXIT.WORKER_DIED,
          );
        }

        const emit = (payload: Record<string, unknown>): void => {
          if (opts.json === true) process.stdout.write(`${JSON.stringify(payload)}\n`);
          else process.stdout.write(`${String(payload["summary"] ?? "")}\n`);
        };

        if (reply["accepted"] === true) {
          const epoch = reply["epoch"] as number;
          // The durable dispatch record (SRD §7.1), with the ASSIGNED epoch.
          await writeJsonAtomic(inboxTaskPath(run, taskId), { ...envelope, epoch });
          await ledger.append("dispatched", { worker: opts.worker, task_id: taskId, epoch });
          emit({
            accepted: true,
            task_id: taskId,
            worker: opts.worker,
            epoch,
            attempt_id: attemptId,
            replayed: reply["replayed"] === true,
            summary: `dispatched ${taskId} to ${opts.worker} (epoch ${epoch})`,
          });
          return;
        }

        const reason = String(reply["reason"] ?? "rejected");
        if (reason === "already_completed") {
          // ISC-85: a completed (worker, task_id, epoch) re-dispatch is a
          // NO-OP, not an error — exit 0 with the recorded verdict.
          emit({
            accepted: false,
            reason,
            task_id: taskId,
            epoch: reply["epoch"] ?? null,
            verdict: reply["verdict"] ?? null,
            summary: `${taskId} already completed (verdict ${String(reply["verdict"])})`,
          });
          return;
        }
        if (reason === "prompt_rejected") {
          emit({ accepted: false, reason, error: reply["error"] ?? null, summary: `${taskId} rejected by worker` });
          throw new CliError(`worker rejected the prompt for ${taskId}`, EXIT.PARTIAL);
        }
        emit({ accepted: false, reason, summary: `${taskId} not dispatched: ${reason}` });
        throw new CliError(`dispatch rejected: ${reason}`, EXIT.USAGE);
      },
    );
}
