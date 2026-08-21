/**
 * `pifleet steer --worker <id> --message <text>` (SRD §10, ISC-80): inject a
 * mid-turn correction that the agent sees BEFORE its next assistant turn.
 *
 * The CLI's job here is delivery and honesty, not protocol: the supervisor
 * owns the RPC (`steer` over the control socket) and Pi owns the queueing.
 * What this command must NOT do is the failure ISC-80 exists to catch —
 * report success for a message that went nowhere. The supervisor answers
 * `{ok:false, error:"no live epoch"}` for a worker with nothing in flight,
 * and that refusal is surfaced as a named error rather than swallowed: a
 * steer the agent never saw, reported as delivered, is an operator believing
 * they corrected a run that proceeds uncorrected.
 *
 * A successful steer also writes the worker's attended record
 * (`attended.json`, contracts.ts). A steer is a human reaching into a run:
 * the transcript now contains an operator-authored message the task brief
 * never carried, and `report` must be able to say so afterwards. The pane
 * stays in `viewer` mode — steering rides the control plane, not the pane —
 * so nothing in the §3.5 tui-voids table applies and `voided` stays empty.
 */

import type { Command } from "commander";
import { CliError } from "../index.ts";
import { AttendedRecordSchema, EXIT, type AttendedRecord } from "../../contracts.ts";
import { workerPaths } from "../../run/paths.ts";
import { LedgerWriter } from "../../run/ledger.ts";
import { writeJsonAtomic } from "../../util/jsonl.ts";
import { controlCall } from "../../supervisor/launch.ts";
import { requireLiveWorker, resolveRunPaths } from "../worker-preflight.ts";
import { ATTENDED_SCHEMA, AttendedSchemaError } from "../../attended/mode.ts";

/**
 * Generous relative to the socket default (5s): the supervisor forwards the
 * steer to Pi and awaits Pi's ack before answering, so the CLI's clock must
 * outlast the inner RPC's — otherwise a slow Pi surfaces as "worker died"
 * when the truthful answer ("Pi did not ack the steer") was one second away.
 */
const STEER_TIMEOUT_MS = 10_000;

/**
 * One message from two possible spellings — the SRD's positional
 * (`pifleet steer --worker <id> "msg"`) and the flag form (`--message`).
 *
 * Both given and DIFFERENT is refused rather than either being picked:
 * whichever one this code preferred, the other is a message the operator
 * typed and believes was delivered. Exported for the unit suite.
 */
export function resolveMessage(
  positional: string | undefined,
  flag: string | undefined,
): string {
  if (positional !== undefined && flag !== undefined && positional !== flag) {
    throw new CliError(
      "steer got two different messages (positional and --message); use one",
      EXIT.USAGE,
    );
  }
  const message = flag ?? positional;
  if (message === undefined || message.trim() === "") {
    throw new CliError("steer requires a message (--message <text> or positional)", EXIT.USAGE);
  }
  return message;
}

/**
 * The attended record to write after a delivered steer, or null to leave the
 * file alone. Pure, exported for the unit suite.
 *
 * Three cases, and the third is the load-bearing one:
 * - no record: create one. `entered_at` and `left_at` are both this steer —
 *   the intervention is a point event, not a possession of the pane.
 * - a `viewer` record (a previous steer): advance `left_at`, preserve
 *   `entered_at` and `voided`. The record accumulates; it never resets,
 *   because the RUN was touched even if the last steer was hours ago.
 * - a `tui` record: return null and touch NOTHING. `left_at: null` there
 *   means an operator is driving the pane right now, and a steer that
 *   "updated" it would record the pane as handed back when it was not.
 */
export function nextAttendedRecord(
  existing: AttendedRecord | null,
  worker: string,
  now: string,
): AttendedRecord | null {
  if (existing === null) {
    return AttendedRecordSchema.parse({
      schema: "pifleet.attended/v1",
      worker,
      mode: "viewer",
      entered_at: now,
      left_at: now,
      voided: [],
    });
  }
  if (existing.mode === "tui") return null;
  return { ...existing, left_at: now };
}

/**
 * Read an existing attended record, treating an unparsable file as absent.
 *
 * A corrupt record is already unreadable to `report`; refusing to steer over
 * it would let a scribbled file disable a control verb. That leniency is
 * deliberate and stays.
 *
 * A FOREIGN SCHEMA STAMP IS NOT CORRUPTION, and collapsing the two here is
 * what this guard exists to stop. `null` from this function means "no record",
 * and the caller then WRITES a fresh one over the file — so a record written
 * by a different build was silently destroyed by a verb the operator ran for
 * an unrelated reason. Damage may be overwritten; another build's data may
 * not. This is the same reader-level distinction `readAttendedMode` makes in
 * `attended/mode.ts`; `steer` held a second, private copy that had not learned
 * it (ISC-192).
 *
 * Note the shape: `safeParse`-then-return-null is invisible to
 * `durable-reader-wrapping.test.ts`, which scans for unwrapped `.parse`. That
 * is the residual the criterion records, and this is an instance of it found
 * by reading rather than by the guard.
 */
export async function readAttended(path: string): Promise<AttendedRecord | null> {
  let doc: unknown;
  try {
    doc = await Bun.file(path).json();
  } catch {
    return null; // absent or unparsable — the documented lenient case
  }
  const stamp = (doc as { schema?: unknown } | null)?.schema;
  if (typeof stamp === "string" && stamp !== ATTENDED_SCHEMA) {
    throw new AttendedSchemaError(path, stamp);
  }
  const parsed = AttendedRecordSchema.safeParse(doc);
  return parsed.success ? parsed.data : null;
}

export function register(program: Command): void {
  program
    .command("steer [message]")
    .description("Inject a mid-turn correction into a worker")
    .option("-w, --worker <id>", "worker id")
    .option("-m, --message <text>", "the correction to inject")
    .option("-r, --run <id>", "run id (defaults to the most recent run)")
    .option("--json", "emit machine-readable output")
    .action(
      async (
        positional: string | undefined,
        opts: { worker?: string; message?: string; run?: string; json?: boolean },
      ) => {
        if (opts.worker === undefined || opts.worker.trim() === "") {
          throw new CliError("steer requires --worker <id>", EXIT.USAGE);
        }
        const message = resolveMessage(positional, opts.message);
        const run = await resolveRunPaths(opts.run);
        // Liveness BEFORE the socket: a typo'd worker and a dead one refuse
        // connect identically, and only the state file can tell 2 from 6.
        await requireLiveWorker(run, opts.worker);

        /*
         * READ BEFORE DELIVERY, deliberately, and the write still happens
         * after the ack. `readAttended` can now REFUSE a record stamped by
         * another build rather than silently overwriting it — and a refusal
         * downstream of `controlCall` would mean the steer had already landed
         * in a live worker's turn while the command reported failure, with no
         * `steer_sent` ledger row. The operator's next move is to run it
         * again, injecting the same mid-turn correction twice.
         *
         * Here the throw costs nothing: nothing has been delivered. The
         * "a refused steer must not brand the run attended" rule is about the
         * WRITE, which is still below the ack where it belongs.
         */
        const wp = workerPaths(run, opts.worker);
        const existingAttended = await readAttended(wp.attendedJson);

        let reply: Record<string, unknown>;
        try {
          reply = await controlCall(
            run,
            opts.worker,
            { cmd: "steer", message },
            { timeoutMs: STEER_TIMEOUT_MS },
          );
        } catch (err) {
          // Alive a moment ago, unreachable now: the supervisor died between
          // the preflight and the call. Same code the preflight would give.
          throw new CliError(
            `worker ${opts.worker} in run ${run.runId} is unreachable: ${String(err)}`,
            EXIT.WORKER_DIED,
          );
        }

        if (reply["ok"] !== true) {
          const error = typeof reply["error"] === "string" ? reply["error"] : "rejected";
          if (error === "no live epoch") {
            // ISC-80's silent-failure case: nothing is running, so nothing
            // will ever read this message. Saying so is the whole point.
            throw new CliError(
              `worker ${opts.worker} in run ${run.runId} has no live epoch — nothing to steer`,
              EXIT.USAGE,
            );
          }
          throw new CliError(
            `worker ${opts.worker} did not accept the steer: ${error}`,
            EXIT.PARTIAL,
          );
        }

        // Delivered. Record the intervention: the attended record marks the
        // run as human-touched (write-once, never removed), and the ledger
        // carries the audit row. Both AFTER the ack — a refused steer must
        // not brand the run attended.
        const record = nextAttendedRecord(
          existingAttended,
          opts.worker,
          new Date().toISOString(),
        );
        if (record !== null) await writeJsonAtomic(wp.attendedJson, record);
        const ledger = new LedgerWriter(run, `cli-steer-${process.pid}`);
        await ledger.append("steer_sent", {
          worker: opts.worker,
          detail: { message: message.slice(0, 500) },
        });

        if (opts.json === true) {
          process.stdout.write(
            `${JSON.stringify({
              run_id: run.runId,
              worker: opts.worker,
              delivered: true,
              message,
            })}\n`,
          );
        } else {
          process.stdout.write(`steered ${opts.worker}\n`);
        }
      },
    );
}
