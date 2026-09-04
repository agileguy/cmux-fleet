/**
 * THE CONSOLE'S ACTOR, AND THE SUPERVISION STORY THAT CAN ACTUALLY BE HONOURED
 * — SRD-REVIEW-CONSOLE §6.5, §9 Q4.
 *
 * `grep relay scripts/review` returned nothing. The console stood up four panes
 * and never started the thing that turns a collator's `dispatch-request.json`
 * into three reviews, so every part of the mechanism existed and the console did
 * not work: a collator would write a request, settle `partial`, and nothing on
 * the host would ever read it. §6.4's own failure shape, in the console built to
 * avoid it — *"a collator that dispatched three reviews is indistinguishable
 * from one that dispatched none"*.
 *
 * §6.5 offers three homes and objects to each. This module implements the
 * second — *"a new `pifleet relay` process, started by `scripts/review`"* —
 * and the whole of it is an answer to that option's stated objection: **"a fifth
 * process with no pane, no supervision, and no story for what happens when it
 * dies mid-fan-out. Nothing in this fleet is currently supervised by a shell
 * script."**
 *
 * ## THE STORY, IN FOUR PARTS, EACH OF WHICH IS HONOURED RATHER THAN CLAIMED
 *
 * 1. **A dead relay costs nothing but time, because its state is on disk.**
 *    `relay-journal.ts` owns "has parent T been fanned out", and `cli/commands/
 *    relay.ts` says it plainly: *"Idempotency IS the supervision story."* A
 *    process killed mid-fan-out has not journalled, so the next one re-dispatches
 *    rather than losing the review. That is what makes the remaining three parts
 *    sufficient rather than a fig leaf.
 * 2. **A crash inside a pass no longer ends the actor.** The loop catches, logs
 *    to stderr and continues. That is not this module's doing, and it is named
 *    here because it is what makes "started once" a viable shape at all.
 * 3. **Restarting it is one command, and it is the command the operator already
 *    runs.** `./scripts/review` is documented as the expected way to get back to
 *    the console; it is now also the way to get the actor back. The record below
 *    makes that idempotent: a live relay is left alone, a dead one is replaced.
 * 4. **It is visible and it is stoppable.** A background process nobody can name
 *    is the real content of §6.5's objection. The record carries the pid, the run
 *    it is polling, the pin it was given and where its output is going, so
 *    `pifleet down` not knowing about it is a gap an operator can close by hand
 *    rather than a mystery process.
 *
 * ## WHAT IS NOT HONOURED, SAID PLAINLY
 *
 * **Nothing restarts it automatically, and `pifleet down` is not authoritative
 * over it.** Bring the console's runs down outside this script and the relay
 * keeps polling a run that will never answer, quietly, forever — which is
 * §6.4's failure shape one more time. `scripts/review --relay-stop` and the pid
 * in the record are the remedies, and they are operator actions rather than
 * properties of the system. §9 Q4 asks for exactly this and the honest answer is
 * that a shell script cannot supply it; closing it properly means either a
 * supervisor that owns the process or a relay that watches its own run's
 * liveness, and both are larger than the wiring this change is.
 *
 * ## THE IDENTITY IS (pid, start-time) AND NEVER pid ALONE
 *
 * `registry.ts`'s own note records the measurement: a two-day-old dead run was
 * reported live because the OS recycled its pid onto a supervisor started later.
 * A pidfile carrying a bare pid has that defect by construction, and its
 * consequence here is the worse direction — `scripts/review` would find a
 * stranger's process "alive", decline to start a relay, and the console would be
 * silently actorless again.
 */

import { dirname, join } from "node:path";
import { z } from "zod";

import { processStartTime } from "../safety/procstart.ts";
import { runsRoot } from "./paths.ts";

/**
 * Where the record lives: BESIDE the runs root, not inside it.
 *
 * Inside would put a non-run file in the directory `runIdsAscending` enumerates,
 * which is how a stray filename becomes a run id and then a path segment. The
 * parent is `~/.pifleet` by default and follows `PIFLEET_RUNS_DIR` when it is
 * set, so a test never touches the operator's own.
 */
export function relayRecordPath(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(runsRoot(env)), "review-relay.json");
}

/** Where a detached relay's stdout and stderr go. Beside the record. */
export function relayLogPath(env: Record<string, string | undefined> = process.env): string {
  return join(dirname(runsRoot(env)), "review-relay.log");
}

export const RelayRecordSchema = z.object({
  schema: z.literal("pifleet.consolerelay/v1"),
  pid: z.number().int().positive(),
  /** A `processStartTime` token. The half that survives a recycled pid. */
  started: z.string(),
  /** The run this relay was pointed at — the collator's, under D4. */
  run_id: z.string(),
  /** The `PIFLEET_RELAY_RUNS` value it was launched with, or `null`. */
  pinned: z.string().nullable().default(null),
  started_at: z.string(),
  log_path: z.string(),
});
export type RelayRecord = z.infer<typeof RelayRecordSchema>;

/**
 * What a record on disk means right now.
 *
 * `absent` and `stale` are deliberately different answers even though both lead
 * to "start one". A stale record is evidence that a relay ran and stopped —
 * possibly because it crashed on its first pass — and an operator who sees the
 * distinction knows to read the log. `absent` says nothing ever started.
 */
export type RelayStatus =
  | { kind: "absent" }
  | { kind: "stale"; record: RelayRecord }
  | { kind: "unreadable"; reason: string }
  | { kind: "live"; record: RelayRecord };

/**
 * Read the record and decide whether the process it names is still ours.
 *
 * `identityAlive`'s comparison, inlined rather than imported, so this module
 * does not pull in `registry.ts` — which reaches the run enumerator, the worker
 * state reader and the verbgate collector to answer a question about one pid.
 */
export async function readRelayStatus(path: string): Promise<RelayStatus> {
  let raw: unknown;
  try {
    raw = await Bun.file(path).json();
  } catch (err) {
    // ENOENT is the ordinary state and is not an error worth a reason.
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", reason: err instanceof Error ? err.message : String(err) };
  }
  const parsed = RelayRecordSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      kind: "unreadable",
      reason: `${path} is not a relay record: ${parsed.error.issues[0]?.message ?? "invalid"}`,
    };
  }
  const record = parsed.data;
  let started: string | null;
  try {
    started = await processStartTime(record.pid);
  } catch {
    // `ps` could not be read. Treated as UNREADABLE and not as stale: the
    // caller must not kill or replace a process it could not identify.
    return { kind: "unreadable", reason: `could not read the identity of pid ${record.pid}` };
  }
  if (started === null || started !== record.started) return { kind: "stale", record };
  return { kind: "live", record };
}

/**
 * The argv for a console relay, as a pure function so the wiring is assertable
 * without spawning anything.
 *
 * `--run` is passed EXPLICITLY and never left to `resolveCollatorRun`. That
 * default resolves *"the newest live run that actually materialised a
 * collator"* by checking whether the worker's DIRECTORY exists — and
 * `productionRunSources.isLiveWorker` records why that predicate is not
 * liveness: *"`pifleet down` removes containers and leaves directories, so every
 * run this operator has ever started answered `true`"*. The script has just read
 * `status --all --json`, which carries the real `alive` flag, so it knows the
 * answer better than the fallback can and says so rather than relying on it.
 */
export function consoleRelayArgv(cliEntry: string, runId: string): string[] {
  return ["bun", "run", cliEntry, "relay", "--run", runId];
}

/**
 * Stop a relay we recorded, and say what happened.
 *
 * SIGTERM to the pid alone and never to a process group. `down.ts` signals
 * groups because it is reaping supervisors that own containers; this is one
 * `bun` process with no children, and a group signal from a record that could be
 * stale is how an unrelated shell dies. The identity check above is what makes
 * even the single signal safe, and it is the caller's job to have made it.
 */
export function signalRelay(pid: number): "signalled" | "gone" | "refused" {
  try {
    process.kill(pid, "SIGTERM");
    return "signalled";
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ESRCH") return "gone";
    return "refused";
  }
}
