/**
 * `pifleet harvest --reconstruct --worker <id>` — rebuild a verdict from the
 * transcript alone (SRD §8.2 path 2, §8.4, ISC-91).
 *
 * This is the path for a worker that died after doing work but before writing
 * `result.json`. The transcript is authoritative for ATTEMPTS: it proves
 * aborts, errors, and death mid-turn, and it carries the A6 usage that the
 * budget must still account for. It cannot prove task success — clean endings
 * reconstruct as `unknown`, which the adjudication lattice treats as identity,
 * so the repository's derived facts carry the final verdict (SRD §7.3).
 *
 * Like `artifacts`, this is a pure read: it exits 0 whenever it emitted valid
 * output, and the trustworthiness of the harvest travels in `harvest_status`,
 * not in the exit code (SRD §8.4). Nonzero is reserved for usage errors.
 */

import type { Command } from "commander";
import { CliError } from "../index.ts";
import { EXIT } from "../../contracts.ts";
import {
  classifySession,
  readTranscript,
  reconstruct,
  type Reconstruction,
} from "../../harvest/transcript.ts";
import { combineUsage, tokensTotal, ZERO_USAGE, type UsageTotals } from "../../harvest/usage.ts";
import { presenceLine, resolveWorker } from "./transcript.ts";

/** Register `pifleet harvest` (SRD §10). */
export function register(program: Command): void {
  program
    .command("harvest")
    .description("Rebuild a verdict from the transcript when the envelope is missing")
    .option("-w, --worker <id>", "worker id")
    .option("--run <id>", "run id (default: latest)")
    .option("--reconstruct", "derive the verdict from the transcript")
    .option("--json", "emit machine-readable output")
    .action(async (opts: { worker?: string; run?: string; reconstruct?: boolean; json?: boolean }) => {
      if (opts.reconstruct !== true) {
        // The only harvest mode that exists; requiring the flag keeps the
        // surface honest about what ran rather than silently defaulting.
        throw new CliError("harvest requires --reconstruct", EXIT.USAGE);
      }
      const { run, state, workerId } = await resolveWorker(opts.worker, opts.run, "harvest");
      const presence = await classifySession(state);

      let rec: Reconstruction | null = null;
      let malformed = 0;
      let truncated = 0;
      if (presence === "present") {
        const reader = await readTranscript(state.session_path as string);
        rec = reconstruct(reader);
        malformed = reader.malformed;
        truncated = reader.truncated;
      }

      // A6 merges the two sources it is DESIGNED for, but only one of them
      // exists: `state.usage` is never written — nothing sends
      // `get_session_stats` — so it is always the zero default here and this
      // merge returns the transcript total unchanged. See harvest/usage.ts.
      const transcriptUsage: UsageTotals = rec?.usage ?? ZERO_USAGE;
      const usage = combineUsage(state.usage, transcriptUsage);

      // The harvest's own trustworthiness, orthogonal to the verdict: a
      // transcript with corrupt or oversized lines was still harvested, but a
      // consumer must be able to see that records are missing from it.
      const harvestStatus =
        presence !== "present"
          ? "unavailable"
          : malformed > 0 || truncated > 0 || rec?.path_complete !== true
            ? "partial"
            : "complete";

      const reasons =
        rec !== null
          ? rec.reasons
          : presence === "never_created"
            ? ["worker_died_before_first_assistant_message"]
            : presence === "missing_after_present"
              ? ["session_file_missing_at_recorded_path"]
              : ["no_session_path_recorded"];

      const payload = {
        schema: "pifleet.reconstruction/v1",
        run_id: run.runId,
        worker: workerId,
        task_id: state.task_id,
        epoch: state.epoch,
        session_path: state.session_path,
        presence,
        harvest_status: harvestStatus,
        verdict: rec?.verdict ?? "unknown",
        reasons,
        turns: rec?.turns ?? 0,
        tool_calls: rec?.tool_calls ?? 0,
        tool_errors: rec?.tool_errors ?? 0,
        compactions: rec?.compactions ?? 0,
        last_assistant: rec?.last_assistant ?? null,
        usage,
        tokens_total: tokensTotal(usage),
        entries_total: rec?.entries_total ?? 0,
        path_complete: rec?.path_complete ?? false,
        malformed,
        truncated,
      };

      if (opts.json === true) {
        process.stdout.write(`${JSON.stringify(payload)}\n`);
        return;
      }
      const lines = [
        `worker ${workerId} (run ${run.runId})`,
        presenceLine(presence),
        `verdict: ${payload.verdict} [${harvestStatus}]`,
        ...reasons.map((r) => `  - ${r}`),
        `turns ${payload.turns}, tool calls ${payload.tool_calls}, tool errors ${payload.tool_errors}`,
        `tokens ${payload.tokens_total}${usage.priced ? ` ($${usage.usd.toFixed(2)})` : " (unpriced)"}`,
      ];
      process.stdout.write(`${lines.join("\n")}\n`);
    });
}
