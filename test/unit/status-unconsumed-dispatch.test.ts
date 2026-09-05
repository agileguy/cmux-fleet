/**
 * `status` can see a dispatch-request that NOTHING CONSUMED.
 *
 * ## The defect, as measured
 *
 * A review console's collator ran its turn, wrote a well-formed
 * `dispatch-request.json`, ended its turn and reported success. No relay actor
 * was running, so nothing read it, and the review never happened. Every
 * observable read healthy: the worker was `idle`, its result envelope was
 * written, the outbox was populated.
 *
 *   ~/.pifleet/runs/2026-09-05T02-04-34Z-5f25/outbox/col-1/R-rally-async-6/
 *     dispatch-request.json        3971 bytes, unconsumed for minutes
 *
 * Starting the relay made the fan-out fire instantly. `pifleet status --all`
 * could not report any of it: `status.ts` named the relay zero times, and
 * `readRelayStatus` was reachable only from `scripts/review` — so the documented
 * way to ask what the fleet is doing was blind to a console with no actor.
 *
 * ## What is reported, and why it is the HARM rather than a proxy for it
 *
 * The signal is two files that are both already on disk:
 *
 *   the request        `<run>/outbox/<worker>/<task>/dispatch-request.json`
 *   the consumed mark  `<run>/relay/<worker>/<task>.json`  (`relayJournalPath`)
 *
 * A request with no journal entry is a review that has not happened. That is
 * CAUSE-AGNOSTIC by construction — a dead actor, an actor pointed at the wrong
 * run, an actor that crashed and an actor that refuses all produce it — and it
 * is SELF-GATING, because only a collator writes a `dispatch-request.json`, so
 * every worker in a fleet that has none stays silent.
 *
 * It is deliberately NOT a second opinion about the relay PROCESS.
 * `readRelayStatus`'s strictness exists because it licenses signalling and
 * replacing a process; `status` licenses nothing and spends nothing, so it must
 * not claim that certainty — and calling it would make `status` shell out to
 * `ps` through `processStartTime`, which this command's whole value depends on
 * not doing.
 *
 * ## The honest edge: a missing journal entry has MORE THAN ONE cause
 *
 * A REFUSED fan-out is deliberately never journalled.
 * `src/cli/commands/relay.ts:450` pushes `fan_out_declined` and `continue`s, and
 * `RelayFanOutResult` explains why: journalling it would mark a fan-out complete
 * that never happened, and under D5 the collator has already settled and named
 * three child ids, so nothing downstream would ever notice. `readDispatchRequest`
 * refusals (§6.4, D7, D11) are the same shape one step earlier.
 *
 * So "no journal entry" means EITHER nothing has read the request OR something
 * read it and declined — and nothing durable in the run tree tells the two
 * apart, because the whole point of not journalling a decline is that no record
 * is written. The message therefore states BOTH and names the one command that
 * settles it, rather than asserting a cause it cannot know. A confident wrong
 * cause is worse than an honest "one of these two, look here".
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  UNCONSUMED_AFTER_MS,
  classifyDispatchRequest,
  dispatchNote,
  type DispatchInput,
  type DispatchReading,
} from "../../src/cli/commands/status.ts";
import { dispatchRequestPath } from "../../src/run/dispatch-request.ts";
import { runPaths, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import { RELAY_SETTLE_DEADLINE_MS } from "../../src/run/relay.ts";
import { RELAY_JOURNAL_SCHEMA, relayJournalPath } from "../../src/run/relay-journal.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import { spawnCli } from "../support/spawn-cli.ts";

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// THE THRESHOLD IS BORROWED, and this is where that is checked rather than said
// ---------------------------------------------------------------------------

describe("the window is one of the fleet's own numbers", () => {
  /**
   * `DEFAULT_POLL_S = 2` is the number a reader reaches for first and it is the
   * WRONG one, because it bounds only how long a request waits to be LOOKED AT.
   * The journal is written AFTER the whole fan-out
   * (`relay.ts`: `await opts.fanOut(...)` then `recordDispatch`), and the
   * fan-out joins its three children for up to `RELAY_SETTLE_DEADLINE_MS`. A
   * poll-derived threshold would therefore alarm on every HEALTHY review for as
   * long as it ran, which is the false alarm the design must not produce.
   */
  test("it is RELAY_SETTLE_DEADLINE_MS, the longest a fan-out may legitimately hold a request", () => {
    expect(UNCONSUMED_AFTER_MS).toBe(RELAY_SETTLE_DEADLINE_MS);
  });

  /**
   * The `--poll` concern is answered as a COROLLARY rather than with a margin of
   * its own. 1_800_000 ms is 900 poll intervals at the default, so an operator
   * would have to poll less than twice an hour before the interval alone could
   * make this fire — and inventing a multiplier to cover that would be exactly
   * the second opinion the borrowed threshold exists to avoid.
   */
  test("it is hundreds of default poll intervals wide, so the poll cannot make it fire", () => {
    const DEFAULT_POLL_MS = 2_000; // `relay.ts`'s DEFAULT_POLL_S = 2, not exported.
    expect(UNCONSUMED_AFTER_MS / DEFAULT_POLL_MS).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// THE ASYMMETRIC FIXTURE, in the pure rule — proved asymmetric before it is used
// ---------------------------------------------------------------------------

/** Every leaf path on which two fixtures differ. */
function differingPaths(a: unknown, b: unknown, prefix = ""): string[] {
  if (a === b) return [];
  const objects = typeof a === "object" && a !== null && typeof b === "object" && b !== null;
  if (!objects) return [prefix];
  const keys = new Set([...Object.keys(a as object), ...Object.keys(b as object)]);
  const out: string[] = [];
  for (const k of keys) {
    out.push(
      ...differingPaths(
        (a as Record<string, unknown>)[k],
        (b as Record<string, unknown>)[k],
        prefix === "" ? k : `${prefix}.${k}`,
      ),
    );
  }
  return out;
}

/** Acted on: the journal says so, so there is nothing to report. */
const consumed: DispatchInput = {
  taskId: "R-rally-async-6",
  journal: { kind: "ok" },
  waitingMs: 41 * MINUTE,
  unconsumedAfterMs: UNCONSUMED_AFTER_MS,
};

/** THE DEFECT: the same request, the same age, and no record that anything acted. */
const orphaned: DispatchInput = {
  taskId: "R-rally-async-6",
  journal: { kind: "missing" },
  waitingMs: 41 * MINUTE,
  unconsumedAfterMs: UNCONSUMED_AFTER_MS,
};

describe("the fixture pair is asymmetric in exactly one fact", () => {
  test("the consumed request and the orphaned one differ ONLY in the journal entry", () => {
    expect(differingPaths(consumed, orphaned)).toEqual(["journal.kind"]);
  });

  test("and they really do differ, so the pair is not a tautology", () => {
    expect(consumed.journal.kind).not.toBe(orphaned.journal.kind);
  });

  test("the differ helper reports a same-valued pair as identical", () => {
    expect(differingPaths(consumed, { ...consumed })).toEqual([]);
    expect(differingPaths(consumed, { ...consumed, taskId: "T-2" })).toEqual(["taskId"]);
  });
});

// ---------------------------------------------------------------------------
// THE RULE
// ---------------------------------------------------------------------------

describe("classifyDispatchRequest separates consumed from unconsumed", () => {
  test("a journalled request is consumed, however old it is", () => {
    expect(classifyDispatchRequest(consumed).verdict).toBe("consumed");
    expect(classifyDispatchRequest({ ...consumed, waitingMs: 99 * MINUTE }).verdict).toBe(
      "consumed",
    );
  });

  /** THE CASE THE DEFECT WAS. */
  test("an unjournalled request past the window is unconsumed, and carries the span", () => {
    const r = classifyDispatchRequest(orphaned);
    expect(r.verdict).toBe("unconsumed");
    expect(r.verdict === "unconsumed" ? r.waitingMs : null).toBe(41 * MINUTE);
  });

  /** THE OTHER DIRECTION, and the one that must not become a false alarm. */
  test("an unjournalled request inside the window is WAITING, not unconsumed", () => {
    const r = classifyDispatchRequest({ ...orphaned, waitingMs: 1_000 });
    expect(r.verdict).toBe("waiting");
    expect(r.verdict).not.toBe("unconsumed");
  });

  test("the boundary is the fleet's own number: one ms under waits, the number itself alarms", () => {
    const at = (waitingMs: number) => classifyDispatchRequest({ ...orphaned, waitingMs }).verdict;
    expect(at(UNCONSUMED_AFTER_MS - 1)).toBe("waiting");
    expect(at(UNCONSUMED_AFTER_MS)).toBe("unconsumed");
  });

  test("the alarm cannot be stricter than the window it is handed", () => {
    // Stated as a property rather than a point: an implementation that
    // hard-coded a threshold of its own would fail here for either window.
    const tight = { ...orphaned, waitingMs: 10_000, unconsumedAfterMs: 5_000 };
    const loose = { ...orphaned, waitingMs: 10_000, unconsumedAfterMs: 7_200_000 };
    expect(classifyDispatchRequest(tight).verdict).toBe("unconsumed");
    expect(classifyDispatchRequest(loose).verdict).toBe("waiting");
  });

  /**
   * A journal entry that exists and cannot be trusted is its OWN fact and must
   * not collapse into either of the other two. `classifyRequest` fails CLOSED on
   * it — the relay refuses to dispatch — so the review will never happen, and
   * calling it `consumed` would be a new lie introduced by this very column.
   */
  test("an unreadable journal entry is a third fact, carrying the reader's own sentence", () => {
    const r = classifyDispatchRequest({
      ...orphaned,
      journal: { kind: "unreadable", reason: "is not valid JSON" },
    });
    expect(r.verdict).toBe("journal_unreadable");
    expect(r.verdict === "journal_unreadable" ? r.reason : null).toBe("is not valid JSON");
  });

  test("no two of the four verdicts share a name", () => {
    const verdicts = [
      classifyDispatchRequest(consumed),
      classifyDispatchRequest(orphaned),
      classifyDispatchRequest({ ...orphaned, waitingMs: 0 }),
      classifyDispatchRequest({ ...orphaned, journal: { kind: "unreadable", reason: "x" } }),
    ].map((r) => r.verdict);
    expect(new Set(verdicts).size).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// WHAT AN OPERATOR SEES — and the two causes, kept honest
// ---------------------------------------------------------------------------

const RUN_ID = "2026-09-05T02-04-34Z-5f25";

describe("dispatchNote speaks only when there is something to do", () => {
  const note = (rs: readonly DispatchReading[]) => dispatchNote(rs, RUN_ID);

  test("an unconsumed request gets a loud line naming the request and the span", () => {
    const line = note([classifyDispatchRequest(orphaned)]);
    expect(line).not.toBeNull();
    expect(line).toContain("UNCONSUMED");
    expect(line).toContain("R-rally-async-6");
    expect(line).toContain("41m");
  });

  /**
   * THE HONEST EDGE, asserted as two facts on one line rather than as prose in a
   * docblock. A message that named only the dead actor would be a confident
   * wrong cause every time a relay had read the request and refused it.
   */
  test("the line states BOTH causes and neither is asserted over the other", () => {
    const line = note([classifyDispatchRequest(orphaned)])!;
    // Cause 1: nothing read it.
    expect(line).toMatch(/nothing has read it/i);
    // Cause 2: something read it and declined, which is never journalled.
    expect(line).toMatch(/declined/i);
    expect(line).toMatch(/never journalled/i);
  });

  test("and it names the one command that tells them apart, against this run", () => {
    const line = note([classifyDispatchRequest(orphaned)])!;
    expect(line).toContain("pifleet relay --once");
    expect(line).toContain(RUN_ID);
  });

  test("a consumed request gets NOTHING, which is the silence the healthy fleet keeps", () => {
    expect(note([classifyDispatchRequest(consumed)])).toBeNull();
  });

  test("a request still inside the window gets nothing either — the false alarm avoided", () => {
    expect(note([classifyDispatchRequest({ ...orphaned, waitingMs: 1_000 })])).toBeNull();
  });

  test("a worker with no requests at all is silent, which is what makes this self-gating", () => {
    expect(note([])).toBeNull();
  });

  test("several unconsumed requests collapse to a count and the OLDEST, not a wall of ids", () => {
    const line = note([
      classifyDispatchRequest({ ...orphaned, taskId: "T-young", waitingMs: 31 * MINUTE }),
      classifyDispatchRequest({ ...orphaned, taskId: "T-oldest", waitingMs: 90 * MINUTE }),
      classifyDispatchRequest({ ...orphaned, taskId: "T-middle", waitingMs: 44 * MINUTE }),
    ])!;
    expect(line).toContain("x3");
    expect(line).toContain("T-oldest");
    expect(line).toContain("1h");
    expect(line).not.toContain("T-young");
  });

  test("an unreadable journal entry gets its own words and the reader's own reason", () => {
    const line = note([
      classifyDispatchRequest({
        ...orphaned,
        journal: { kind: "unreadable", reason: "carries no request_sha256" },
      }),
    ])!;
    expect(line).toContain("BLOCKED");
    expect(line).toContain("R-rally-async-6");
    expect(line).toContain("carries no request_sha256");
    // It must NOT be reported as merely unconsumed: the remedy is different.
    expect(line).not.toContain("UNCONSUMED");
  });
});

// ---------------------------------------------------------------------------
// END-TO-END — the same asymmetry on disk, through a real subprocess
// ---------------------------------------------------------------------------

/**
 * `pifleet status` against a synthetic run, over a real subprocess.
 *
 * ## Why these are not source greps
 *
 * The previous engineer on this file shipped two mutation survivors because
 * `expect(SRC).toMatch(/silenceNote\(/)` also matched the function's own
 * `export function silenceNote(`, and `/silence:/` also matched a type
 * annotation. No tightening of a regex retires that class — a probe that reads
 * SOURCE can always be satisfied by text that is not the code path. These read
 * the OUTPUT: the printed line, and the parsed `--json` document.
 *
 * ## The fixture's asymmetry, on disk
 *
 * ONE run, ONE worker, and four task directories whose requests are byte-
 * identical and stamped at the same instant. Each pair isolates exactly one
 * discriminator:
 *
 *   T-CONSUMED  vs  T-ORPHANED   differ ONLY in the journal entry
 *   T-ORPHANED  vs  T-FRESH      differ ONLY in the request's mtime
 *   T-ORPHANED  vs  T-CORRUPT    differ ONLY in whether the entry parses
 *
 * A fixture where both candidates lacked a journal entry would prove nothing at
 * all, which is why the consumed arm is planted first and asserted silent.
 */
describe("end-to-end: `pifleet status` prints and emits the unconsumed request", () => {
  const COLLATOR = "col-1";
  const REVIEWER = "rev-arch";
  const OLD_MS = 41 * MINUTE;

  let root: string;
  let run: RunPaths;

  /** A request in `worker`'s outbox for `taskId`, stamped `ageMs` in the past. */
  async function plantRequest(worker: string, taskId: string, ageMs: number): Promise<void> {
    const file = dispatchRequestPath(run.root, worker, taskId);
    await mkdir(join(run.root, "outbox", worker, taskId), { recursive: true });
    // Byte-identical for every task, so nothing below can be keying on content.
    await writeFile(
      file,
      JSON.stringify({
        schema: "pifleet.dispatchrequest/v1",
        parent_task_id: taskId,
        targets: [{ worker: REVIEWER, aspect: "architecture" }],
      }),
    );
    const when = new Date(Date.now() - ageMs);
    await utimes(file, when, when);
  }

  /** The host's own record that this task was dispatched — the id set the relay trusts. */
  async function plantInbox(worker: string, taskId: string): Promise<void> {
    await writeFile(
      join(run.inboxDir, `${taskId}.json`),
      JSON.stringify({ schema: "pifleet.task/v1", task_id: taskId, worker }),
    );
  }

  async function plantJournal(worker: string, taskId: string, body: string): Promise<void> {
    const file = relayJournalPath(run.root, worker, taskId);
    await mkdir(join(run.root, "relay", worker), { recursive: true });
    await writeFile(file, body);
  }

  async function plantWorker(worker: string): Promise<void> {
    await mkdir(join(run.workersDir, worker), { recursive: true });
    const state = initialWorkerState({
      worker,
      runId: RUN_ID,
      pid: process.pid,
      pgid: process.pid,
      startedAt: "2026-09-05T02:04:34.000Z",
    });
    // IDLE, deliberately — this is the defect state. The collator ended its turn
    // and reported success, so every worker-level observable reads healthy.
    state.phase = "idle";
    await writeWorkerState(workerPaths(run, worker), state);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pf-unconsumed-"));
    run = runPaths(RUN_ID, root);
    await mkdir(run.workersDir, { recursive: true });
    await mkdir(run.inboxDir, { recursive: true });
    await plantWorker(COLLATOR);
    await plantWorker(REVIEWER);

    for (const taskId of ["T-CONSUMED", "T-ORPHANED", "T-FRESH", "T-CORRUPT"]) {
      await plantInbox(COLLATOR, taskId);
    }
    await plantRequest(COLLATOR, "T-CONSUMED", OLD_MS);
    await plantRequest(COLLATOR, "T-ORPHANED", OLD_MS);
    await plantRequest(COLLATOR, "T-CORRUPT", OLD_MS);
    await plantRequest(COLLATOR, "T-FRESH", 0);

    await plantJournal(
      COLLATOR,
      "T-CONSUMED",
      JSON.stringify({
        schema: RELAY_JOURNAL_SCHEMA,
        sender: COLLATOR,
        parent_task_id: "T-CONSUMED",
        request_sha256: "a".repeat(64),
        children: ["T-CONSUMED-arch"],
        dispatched_at: "2026-09-05T02:10:00.000Z",
      }),
    );
    await plantJournal(COLLATOR, "T-CORRUPT", "{ this is not json");

    // The host never dispatched this one, so no actor will ever look at it and
    // reporting it would be a permanent alarm a WORKER can manufacture by
    // making a directory in the outbox it owns.
    await plantRequest(COLLATOR, "T-FORGED", OLD_MS);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  const statusLine = async (worker: string): Promise<string> => {
    const r = await spawnCli(["status", "--run", RUN_ID], { env: { PIFLEET_RUNS_DIR: root } });
    expect(r.code).toBe(0);
    return r.stdout.split("\n").find((l) => l.trimStart().startsWith(`${worker}:`)) ?? "";
  };

  test("the collator's line carries the alarm, naming the orphaned task and its age", async () => {
    const line = await statusLine(COLLATOR);
    // THE DEFECT, as an operator would have read it before this column existed.
    expect(line).toContain("idle");
    expect(line).toContain("supervisor=up");
    // …and the one fact that now separates a console with an actor from one without.
    expect(line).toContain("UNCONSUMED");
    expect(line).toContain("T-ORPHANED");
    expect(line).toContain("41m");
  });

  test("the consumed request is NOT named — the journal entry is the whole difference", async () => {
    const line = await statusLine(COLLATOR);
    expect(line).not.toContain("T-CONSUMED");
  });

  test("the fresh request is not named either — a request is allowed to be new", async () => {
    const line = await statusLine(COLLATOR);
    expect(line).not.toContain("T-FRESH");
  });

  /**
   * ASSERTED ON `--json` RATHER THAN ON THE LINE, and the battery is why.
   *
   * The first version of this probe read `expect(line).not.toContain("T-FORGED")`
   * and it CANNOT FAIL: the line names only the oldest unconsumed request, and
   * `T-ORPHANED` was planted first, so it stays the oldest whether or not the
   * forged task is counted. The battery's D11 — which drops the inbox gate
   * entirely — left that assertion green and was caught by the `--json` block
   * instead. A probe aimed at a fact the rendering deliberately hides is not a
   * probe, so it is aimed at the place the fact is observable.
   *
   * The positive half is asserted alongside, so the probe cannot pass by the
   * reader having looked at nothing at all.
   */
  test("a task the host never dispatched is invisible, so a worker cannot forge an alarm", async () => {
    const r = await spawnCli(["status", "--run", RUN_ID, "--json"], {
      env: { PIFLEET_RUNS_DIR: root },
    });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout) as {
      workers: Array<{ id: string; dispatch_requests: { requests: Array<{ task_id: string }> } }>;
    };
    const ids = doc.workers
      .find((w) => w.id === COLLATOR)!
      .dispatch_requests.requests.map((q) => q.task_id);
    expect(ids).not.toContain("T-FORGED");
    expect(ids).toContain("T-ORPHANED");
  });

  test("a worker with no outbox at all says nothing, which is the self-gating", async () => {
    const line = await statusLine(REVIEWER);
    expect(line).toContain("idle");
    expect(line).not.toContain("UNCONSUMED");
    expect(line).not.toContain("BLOCKED");
  });

  test("a corrupt journal entry is reported as BLOCKED with the reader's own sentence", async () => {
    const line = await statusLine(COLLATOR);
    expect(line).toContain("BLOCKED");
    expect(line).toContain("T-CORRUPT");
    expect(line).toContain("not valid JSON");
  });

  test("`--json` carries every request, its verdict, its span and the window judged against", async () => {
    const r = await spawnCli(["status", "--run", RUN_ID, "--json"], {
      env: { PIFLEET_RUNS_DIR: root },
    });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout) as {
      workers: Array<{
        id: string;
        dispatch_requests: {
          unconsumed_after_ms: number;
          requests: Array<{
            task_id: string;
            verdict: string;
            waiting_ms: number | null;
            reason: string | null;
          }>;
        };
      }>;
    };
    const col = doc.workers.find((w) => w.id === COLLATOR)!;
    const by = (id: string) => col.dispatch_requests.requests.find((q) => q.task_id === id)!;

    expect(col.dispatch_requests.unconsumed_after_ms).toBe(UNCONSUMED_AFTER_MS);
    expect(by("T-ORPHANED").verdict).toBe("unconsumed");
    expect(by("T-ORPHANED").waiting_ms).toBeGreaterThanOrEqual(OLD_MS);
    expect(by("T-CONSUMED").verdict).toBe("consumed");
    expect(by("T-FRESH").verdict).toBe("waiting");
    expect(by("T-CORRUPT").verdict).toBe("journal_unreadable");
    expect(by("T-CORRUPT").reason).toContain("not valid JSON");

    // The forged task is absent from the machine view too, not merely from the line.
    expect(col.dispatch_requests.requests.map((q) => q.task_id)).not.toContain("T-FORGED");
    // A worker that writes no requests carries an empty list rather than a null.
    expect(doc.workers.find((w) => w.id === REVIEWER)!.dispatch_requests.requests).toEqual([]);
  });

  /**
   * `status` reports the REQUEST, never a second opinion about its validity.
   * Parsing it would mean re-opening a worker-owned path and re-running
   * `readDispatchRequest`'s policy — the check-then-use split that module's
   * header exists to close — and it would make `status` disagree with the relay
   * about who may dispatch whom.
   */
  test("the request's own bytes are never parsed: garbage still reports as unconsumed", async () => {
    const junk = "2026-09-05T02-04-34Z-junk";
    const jroot = await mkdtemp(join(tmpdir(), "pf-unconsumed-junk-"));
    try {
      const jrun = runPaths(junk, jroot);
      await mkdir(jrun.workersDir, { recursive: true });
      await mkdir(jrun.inboxDir, { recursive: true });
      await mkdir(join(jrun.workersDir, COLLATOR), { recursive: true });
      await writeWorkerState(
        workerPaths(jrun, COLLATOR),
        initialWorkerState({
          worker: COLLATOR,
          runId: junk,
          pid: process.pid,
          pgid: process.pid,
          startedAt: "2026-09-05T02:04:34.000Z",
        }),
      );
      await writeFile(
        join(jrun.inboxDir, "T-JUNK.json"),
        JSON.stringify({ task_id: "T-JUNK", worker: COLLATOR }),
      );
      const file = dispatchRequestPath(jrun.root, COLLATOR, "T-JUNK");
      await mkdir(join(jrun.root, "outbox", COLLATOR, "T-JUNK"), { recursive: true });
      await writeFile(file, "not json at all");
      const when = new Date(Date.now() - OLD_MS);
      await utimes(file, when, when);

      const r = await spawnCli(["status", "--run", junk], { env: { PIFLEET_RUNS_DIR: jroot } });
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("UNCONSUMED");
      expect(r.stdout).toContain("T-JUNK");
    } finally {
      await rm(jroot, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// THE INVARIANT THIS COLUMN MUST NOT COST — `status` still spends nothing
// ---------------------------------------------------------------------------

/**
 * `status` is the operator's only view when things are broken, and a snapshot
 * must spend nothing to produce. That is why this column reads two files rather
 * than asking `readRelayStatus` whether an actor is alive: that function calls
 * `processStartTime`, which spawns `ps`, and it earns that cost because it
 * LICENSES signalling and replacing a process. `status` licenses nothing.
 */
describe("the snapshot still spawns nothing of its own", () => {
  test("no relay-process probe reached this file", async () => {
    const src = await Bun.file(
      new URL("../../src/cli/commands/status.ts", import.meta.url).pathname,
    ).text();
    const { stripComments } = await import("../support/source-structure.ts");
    const code = stripComments(src);
    expect(code).not.toContain("readRelayStatus");
    expect(code).not.toContain("Bun.spawn");
    expect(code).not.toContain("child_process");
  });
});
