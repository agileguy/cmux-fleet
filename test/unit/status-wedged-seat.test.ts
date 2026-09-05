/**
 * `status` can tell a busy worker that is WORKING from one that is WEDGED.
 *
 * ## The defect
 *
 * Aborting a task can leave a worker whose `state.json` says `phase: "busy"`,
 * whose `heartbeat_at` is being rewritten every 250 ms, and whose container is
 * gone from `docker ps -a` entirely. The seat reads as working. There is
 * nothing in it. Nothing on the `status` line distinguished the two, so an
 * operator waited on a worker that could not finish and the console's own
 * supervision believed it was alive.
 *
 * ## Why the supervisor cannot notice this by itself
 *
 * `supervisor/index.ts:1109-1143` says it, in the branch that exists because of
 * it. On the `rpc` path `child` IS the worker — a foreground `docker run` whose
 * exit is the unambiguous end of the worker — so a container that dies takes
 * the child with it, `onChildExit` runs, and `phase` becomes `dead`. On the
 * `tui` path `child` is a `docker run -d` CLIENT that returned a few hundred
 * milliseconds after launch, and the supervisor holds NO handle on the
 * container at all. That docblock names the consequence and the substitute:
 *
 *   > What replaces the exit as the LIVENESS signal is not in this function.
 *   > `docker inspect` on the recorded name would be the honest probe and is
 *   > not built here; until it is, a tui worker whose container dies after a
 *   > successful start is detected by its transcript going quiet.
 *
 * The transcript going quiet is detected — and then DISCARDED, which is the
 * hole. `settleFromTranscript` runs `classifyTuiTurn` first and returns early
 * on `reading.phase !== "ended"` (`supervisor/index.ts:2262-2265`), so
 * `TUI_QUIET_MS` is consulted only AFTER an end marker has been seen. A
 * container killed mid-turn writes no end marker, so the quiet clock is never
 * even started and `phase` stays `busy` for as long as the supervisor lives.
 *
 * ## The discriminator, and why it is a subtraction the tree otherwise forbids
 *
 * `heartbeat_at` and `transcript_activity.last_growth_at` are written by the
 * SAME process from the SAME wall clock. Their difference is how long the
 * supervisor has watched the transcript stand still, measured entirely inside
 * one clock — which is NOT the cross-clock subtraction `util/clock.ts` and
 * `safety/reaper.ts` ban, and which is why the reading survives a host suspend,
 * a reader whose clock is skewed, and a `--json` consumer on another machine.
 *
 * ## The honest edge
 *
 * A worker genuinely thinking for a long time between tool calls has a stalled
 * transcript too, and must not be alarmed about. The threshold is therefore
 * BORROWED rather than invented: `stall.event_stall_warn` / `event_stall_kill`
 * from `fleet.yaml`, carried into `run.json` by `runBudgetRecord` and read back
 * by `readRunBudgetPolicy`. This module alarms exactly where the fleet's own
 * stall policy would already KILL, so it cannot be stricter than the opinion
 * the operator configured.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  classifyWorkerSilence,
  silenceNote,
  transcriptNote,
  type SilenceInput,
} from "../../src/cli/commands/status.ts";
import { runPaths, workerPaths, type RunPaths } from "../../src/run/paths.ts";
import { initialWorkerState, writeWorkerState } from "../../src/run/state.ts";
import { spawnCli } from "../support/spawn-cli.ts";
import { stripComments } from "../support/source-structure.ts";

/** The window `fleet.yaml` actually ships, read back from a real `run.json`. */
const WINDOW = { warnMs: 180_000, killMs: 1_500_000 } as const;

const HEARTBEAT = "2026-09-04T12:00:00.000Z";
const beforeHeartbeat = (ms: number) => new Date(Date.parse(HEARTBEAT) - ms).toISOString();

const MINUTE = 60_000;

// ---------------------------------------------------------------------------
// THE ASYMMETRIC FIXTURE — built and proved asymmetric BEFORE anything reads it
// ---------------------------------------------------------------------------

/**
 * A worker that is thinking, not wedged: ten minutes into a single model call,
 * which is inside the band the fleet calls `warn` and outside the one it calls
 * `kill`. This is the reviewer that must never be alarmed about.
 */
const slowButLive: SilenceInput = {
  phase: "busy",
  supervisorAlive: true,
  heartbeatAt: HEARTBEAT,
  activity: { entries: 1462, last_growth_at: beforeHeartbeat(10 * MINUTE) },
  window: WINDOW,
};

/**
 * The defect, as measured: same phase, same live supervisor, same fresh
 * heartbeat, same entry count — a transcript frozen forty-one minutes ago
 * because the container that was writing it is gone.
 */
const wedged: SilenceInput = {
  phase: "busy",
  supervisorAlive: true,
  heartbeatAt: HEARTBEAT,
  activity: { entries: 1462, last_growth_at: beforeHeartbeat(41 * MINUTE) },
  window: WINDOW,
};

/**
 * Every leaf path on which two fixtures differ.
 *
 * This exists because of the recurring defect on this branch: a fixture whose
 * two states differ in MORE than the fact under test makes the probe pass
 * against an implementation that keys on the wrong difference. A rule that
 * looked at `entries`, at `phase`, at `supervisorAlive` or at the heartbeat
 * would satisfy every assertion below if the fixtures disagreed about those
 * too. Asserting the difference set FIRST is what makes the rest of this file
 * a measurement of the discriminator rather than of the fixture.
 */
function differingPaths(a: unknown, b: unknown, prefix = ""): string[] {
  if (a === b) return [];
  const objects =
    typeof a === "object" && a !== null && typeof b === "object" && b !== null;
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

describe("the fixture pair is asymmetric in exactly one fact", () => {
  test("the live worker and the wedged worker differ ONLY in last_growth_at", () => {
    expect(differingPaths(slowButLive, wedged)).toEqual(["activity.last_growth_at"]);
  });

  test("and they really do differ, so the pair is not a tautology", () => {
    expect(slowButLive.activity?.last_growth_at).not.toBe(wedged.activity?.last_growth_at);
  });

  test("the differ helper reports a same-valued pair as identical", () => {
    // The helper is load-bearing for the claim above, so it is exercised in
    // both directions: a helper that always returned one path would make the
    // asymmetry assertion pass for any pair at all.
    expect(differingPaths(slowButLive, { ...slowButLive })).toEqual([]);
    expect(differingPaths(slowButLive, { ...slowButLive, phase: "idle" })).toEqual(["phase"]);
  });
});

// ---------------------------------------------------------------------------
// THE RULE, in both directions
// ---------------------------------------------------------------------------

describe("classifyWorkerSilence separates working from wedged", () => {
  /** THE CASE THE DEFECT WAS. */
  test("a fresh heartbeat over a long-dead transcript is wedged", () => {
    const r = classifyWorkerSilence(wedged);
    expect(r.verdict).toBe("wedged");
    expect(r.verdict === "wedged" ? r.silentMs : null).toBe(41 * MINUTE);
  });

  /** THE OTHER DIRECTION, and the one that must not become a false alarm. */
  test("a reviewer ten minutes into one model call is quiet, NOT wedged", () => {
    const r = classifyWorkerSilence(slowButLive);
    expect(r.verdict).toBe("quiet");
    expect(r.verdict).not.toBe("wedged");
  });

  test("a transcript that grew a moment ago is working", () => {
    const r = classifyWorkerSilence({
      ...slowButLive,
      activity: { entries: 1462, last_growth_at: beforeHeartbeat(3_000) },
    });
    expect(r.verdict).toBe("working");
  });
});

describe("the band edges are the fleet's own numbers, not new ones", () => {
  const at = (silentMs: number) =>
    classifyWorkerSilence({
      ...slowButLive,
      activity: { entries: 1462, last_growth_at: beforeHeartbeat(silentMs) },
    }).verdict;

  test("one millisecond under warn is working; warn itself is quiet", () => {
    expect(at(WINDOW.warnMs - 1)).toBe("working");
    expect(at(WINDOW.warnMs)).toBe("quiet");
  });

  test("one millisecond under kill is quiet; kill itself is wedged", () => {
    // The whole width of the warn band is deliberately NOT an alarm: the fleet
    // says a worker silent this long deserves a warning and not a kill, and a
    // status line that shouted here would be inventing a second opinion.
    expect(at(WINDOW.killMs - 1)).toBe("quiet");
    expect(at(WINDOW.killMs)).toBe("wedged");
  });

  test("the alarm cannot be stricter than the fleet's kill threshold", () => {
    // Stated as a property rather than a point: whatever window a run records,
    // nothing below `killMs` may read as wedged. An implementation that
    // hard-coded a threshold of its own would fail here for a run configured
    // differently from `fleet.yaml`.
    const tight = { warnMs: 1_000, killMs: 5_000 };
    const loose = { warnMs: 600_000, killMs: 7_200_000 };
    const silent = 41 * MINUTE;
    const activity = { entries: 1462, last_growth_at: beforeHeartbeat(silent) };
    expect(classifyWorkerSilence({ ...wedged, activity, window: tight }).verdict).toBe("wedged");
    expect(classifyWorkerSilence({ ...wedged, activity, window: loose }).verdict).toBe("quiet");
  });
});

// ---------------------------------------------------------------------------
// THE GATES — every way the rule declines to answer, kept apart
// ---------------------------------------------------------------------------

describe("only a worker that CLAIMS to be running a task can be wedged", () => {
  /**
   * `phase` is the analogue of `classifyStall`'s `holdsSlot`, and for the same
   * reason that field gives: silence alone is never grounds for an alarm,
   * because a worker that is not claiming to run anything is silent by design.
   */
  test("an idle worker with the same dead transcript is not applicable", () => {
    expect(classifyWorkerSilence({ ...wedged, phase: "idle" }).verdict).toBe("not_applicable");
  });

  test("neither is a settling, starting, stalled or dead one", () => {
    for (const phase of ["settling", "starting", "stalled", "dead"] as const) {
      expect(classifyWorkerSilence({ ...wedged, phase }).verdict).toBe("not_applicable");
    }
  });

  test("nor a worker whose state.json could not be read at all", () => {
    expect(classifyWorkerSilence({ ...wedged, phase: null }).verdict).toBe("not_applicable");
  });
});

describe("a dead supervisor is the reaper's business, not this rule's", () => {
  /**
   * Both stamps froze together when the supervisor died, so their difference is
   * whatever it happened to be at that moment and says nothing about now. The
   * line already reads `supervisor=gone`, which is the honest and actionable
   * fact; adding WEDGED beside it would put an alarm on all 231 dead runs on
   * this host.
   */
  test("supervisor=gone is not_applicable however stale the transcript", () => {
    expect(classifyWorkerSilence({ ...wedged, supervisorAlive: false }).verdict).toBe(
      "not_applicable",
    );
  });
});

describe("the four ways the rule cannot answer stay four different facts", () => {
  test("an rpc worker carries no activity record at all", () => {
    // `transcript_activity` is `null` for every worker that is not attended.
    // NOT MEASURED must render as silence, never as zero.
    const r = classifyWorkerSilence({ ...wedged, activity: null });
    expect(r.verdict).toBe("unknown");
    expect(r.verdict === "unknown" ? r.why : null).toBe("no_activity_record");
  });

  test("a watched transcript that has never grown makes no claim either way", () => {
    // `contracts.ts` and `supervisor/index.ts:2007-2010` are explicit: this
    // value "does NOT mean the worker is stuck, and nothing derived from it may
    // say so". A worker nobody has typed at yet is in exactly this position.
    const r = classifyWorkerSilence({
      ...wedged,
      activity: { entries: 0, last_growth_at: null },
    });
    expect(r.verdict).toBe("unknown");
    expect(r.verdict === "unknown" ? r.why : null).toBe("no_growth_yet");
  });

  test("a run that records no silence window gives the rule no threshold", () => {
    const r = classifyWorkerSilence({ ...wedged, window: null });
    expect(r.verdict).toBe("unknown");
    expect(r.verdict === "unknown" ? r.why : null).toBe("no_window");
  });

  test("a stamp that will not parse is a corruption, not a quiet worker", () => {
    for (const bad of [
      { ...wedged, heartbeatAt: "garbage" },
      { ...wedged, heartbeatAt: null },
      { ...wedged, activity: { entries: 1, last_growth_at: "garbage" } },
    ]) {
      const r = classifyWorkerSilence(bad);
      expect(r.verdict).toBe("unknown");
      expect(r.verdict === "unknown" ? r.why : null).toBe("unreadable_stamp");
    }
  });

  test("no two of the four unknowns share a reason string", () => {
    // Collapsing them is how this field would come to lie the way `phase` did:
    // "I have no threshold" and "this worker has never spoken" are different
    // things for an operator to do something about.
    const reasons = [
      classifyWorkerSilence({ ...wedged, activity: null }),
      classifyWorkerSilence({ ...wedged, activity: { entries: 0, last_growth_at: null } }),
      classifyWorkerSilence({ ...wedged, window: null }),
      classifyWorkerSilence({ ...wedged, heartbeatAt: "garbage" }),
    ].map((r) => (r.verdict === "unknown" ? r.why : r.verdict));
    expect(new Set(reasons).size).toBe(4);
  });
});

describe("the reading is taken inside one clock", () => {
  /**
   * A transcript poll can land microseconds after the heartbeat that shares its
   * tick, so `last_growth_at` may be marginally AHEAD of `heartbeat_at`. That
   * is a sub-tick ordering, not a worker that wrote in the future.
   */
  test("growth stamped after the heartbeat clamps to zero rather than going negative", () => {
    const r = classifyWorkerSilence({
      ...wedged,
      activity: { entries: 1462, last_growth_at: beforeHeartbeat(-40) },
    });
    expect(r.verdict).toBe("working");
    expect(r.verdict === "working" ? r.silentMs : null).toBe(0);
  });

  /**
   * THE PROPERTY THAT MAKES THE READING PORTABLE. The verdict is a function of
   * the two recorded stamps and nothing else — no wall clock of the reader's,
   * so a suspended laptop, a skewed host and a `--json` consumer on another
   * machine all compute the same answer.
   */
  test("the same state read at two different real instants gives one answer", () => {
    const first = classifyWorkerSilence(wedged);
    const spin = Date.now();
    while (Date.now() - spin < 5) {
      /* burn a few real milliseconds */
    }
    expect(classifyWorkerSilence(wedged)).toEqual(first);
  });
});

// ---------------------------------------------------------------------------
// WHAT AN OPERATOR SEES
// ---------------------------------------------------------------------------

describe("silenceNote speaks only when there is something to do", () => {
  test("the wedged worker gets a loud line naming the silence and the cause", () => {
    const note = silenceNote(classifyWorkerSilence(wedged));
    expect(note).not.toBeNull();
    expect(note).toContain("WEDGED");
    expect(note).toContain("41m");
    expect(note).toContain("container");
  });

  test("the slow-but-live worker gets NOTHING, which is the false alarm avoided", () => {
    expect(silenceNote(classifyWorkerSilence(slowButLive))).toBeNull();
    expect(silenceNote(classifyWorkerSilence({ ...slowButLive, phase: "idle" }))).toBeNull();
  });

  /**
   * The one unknown that is worth a word. The other three already have a note
   * on the same line from `transcriptNote` — `transcript no writes yet`, or
   * nothing at all for a worker with no record — but a MISSING WINDOW is
   * invisible: the rule silently has no threshold, and an operator cannot tell
   * "no alarm because healthy" from "no alarm because I cannot judge".
   */
  test("a busy worker with no recorded window says the window is unknown", () => {
    const note = silenceNote(classifyWorkerSilence({ ...wedged, window: null }));
    expect(note).toBe("silence-window unknown");
  });

  test("the other unknowns stay silent, because the line already carries them", () => {
    expect(silenceNote(classifyWorkerSilence({ ...wedged, activity: null }))).toBeNull();
    expect(
      silenceNote(
        classifyWorkerSilence({ ...wedged, activity: { entries: 0, last_growth_at: null } }),
      ),
    ).toBeNull();
    expect(silenceNote(classifyWorkerSilence({ ...wedged, heartbeatAt: "garbage" }))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// NEGATIVE CONTROL — must stay GREEN when the rule above is mutated
// ---------------------------------------------------------------------------

describe("negative control: the pre-existing transcript column is untouched", () => {
  const NOW = Date.parse("2026-09-01T06:10:00.000Z");

  test("transcriptNote still keeps its three facts apart", () => {
    expect(transcriptNote({ entries: 1462, last_growth_at: "2026-09-01T06:09:57.000Z" }, NOW)).toBe(
      "transcript 3s ago",
    );
    expect(transcriptNote({ entries: 900, last_growth_at: null }, NOW)).toBe(
      "transcript no writes yet",
    );
    expect(transcriptNote(null, NOW)).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// WIRING — the rule reaching an operator, which correctness alone does not do
// ---------------------------------------------------------------------------

describe("the status action actually consults the rule", () => {
  const SRC = stripComments(
    readFileSync(new URL("../../src/cli/commands/status.ts", import.meta.url).pathname, "utf8"),
  );

  test("the classifier is called, and its result guarded before interpolation", () => {
    // Deliberately WEAK, and paired with the end-to-end block below rather than
    // trusted alone. A grep for `silenceNote(` matches this file's own
    // `export function silenceNote(` — measured: a mutation replacing the call
    // with `const wedge = null;` left this assertion green. The behavioural
    // probes are what actually hold the wiring; this only pins the guard shape,
    // whose absence would print the literal `null` on every healthy worker.
    expect(SRC).toMatch(/classifyWorkerSilence\(/);
    expect(SRC).toMatch(/wedge === null \? "" :/);
  });

  test("the window is read from the run rather than hard-coded", () => {
    // A literal 1500000 or 1_500_000 anywhere in this file would be a second
    // opinion about how long is too long, which is the thing the borrowed
    // threshold exists to avoid.
    expect(SRC).toMatch(/readRunBudgetPolicy\(/);
    expect(SRC).not.toMatch(/1[_]?500[_]?000/);
    expect(SRC).not.toMatch(/180[_]?000/);
  });

  test("the window is read ONCE per run, not once per worker", () => {
    expect([...SRC.matchAll(/readRunBudgetPolicy\(/g)]).toHaveLength(1);
  });

  /**
   * The pre-existing anchor, restated here because this change is the one most
   * likely to break it: a rule that reached for the reader's wall clock would
   * add a second `Date.now()` and would stop being portable at the same moment.
   */
  test("still exactly one clock reading in the whole file", () => {
    expect(SRC).toMatch(/const nowMs = Date\.now\(\);/);
    expect([...SRC.matchAll(/Date\.now\(\)/g)]).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// END-TO-END — the alarm actually reaching an operator
// ---------------------------------------------------------------------------

/**
 * `pifleet status` against a synthetic run, over a real subprocess.
 *
 * ## Why these are not source greps
 *
 * They were, and the mutation battery falsified them.
 * `wedged-seat.battery.ts`'s W1 replaced `const wedge = silenceNote(w.silence)`
 * with `const wedge = null` — the alarm computed and thrown away — and the
 * grep-based probe stayed GREEN, because `silenceNote(` also matches the
 * function's own `export function silenceNote(`. W3 renamed the `--json` key to
 * `silence_omitted` and stayed green, because `silence:` also matches the
 * `silence: SilenceReading;` in the local array's type annotation.
 *
 * Both survivors are the same class of error and no amount of tightening the
 * regex retires the class: a probe that reads SOURCE can always be satisfied by
 * text that is not the code path. These read the OUTPUT instead, so the only
 * thing that can satisfy them is the line an operator actually gets.
 *
 * ## Hermetic by construction (ISC-455's rule)
 *
 * A temp directory, a `PIFLEET_RUNS_DIR` pointing at it, and `spawnCli`'s
 * hermetic cwd. No Docker, no pty, no socket, no worker image — `status` reads
 * durable files and nothing else, which is the property that makes it testable
 * this way at unit speed.
 *
 * `pid: process.pid` is the one pid a unit test can be sure is alive, and it is
 * load-bearing rather than incidental: with a fabricated pid `processStartTime`
 * returns null, `alive` is false, and the rule short-circuits to
 * `not_applicable` — the wedged assertion would fail for entirely the wrong
 * reason, and the healthy one would pass for one.
 */
describe("end-to-end: `pifleet status` prints and emits the verdict", () => {
  const RUN_ID = "2026-09-04T12-00-00Z-wedge";
  const HB = "2026-09-04T12:00:00.000Z";
  let root: string;
  let run: RunPaths;

  /** Plants one worker whose transcript last grew `silentMs` before its heartbeat. */
  async function plant(worker: string, silentMs: number): Promise<void> {
    await mkdir(join(run.workersDir, worker), { recursive: true });
    const state = initialWorkerState({
      worker,
      runId: RUN_ID,
      pid: process.pid,
      pgid: process.pid,
      startedAt: HB,
    });
    state.phase = "busy";
    state.task_id = `t-${worker}`;
    state.heartbeat_at = HB;
    state.transcript_activity = {
      entries: 1462,
      last_growth_at: new Date(Date.parse(HB) - silentMs).toISOString(),
    };
    await writeWorkerState(workerPaths(run, worker), state);
  }

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "pf-wedge-"));
    run = runPaths(RUN_ID, root);
    await mkdir(run.workersDir, { recursive: true });
    // The window the fleet actually ships, in the shape `up` writes it.
    await writeFile(
      run.runJson,
      JSON.stringify({
        schema: "pifleet.run/v1",
        run_id: RUN_ID,
        stall: { event_stall_warn_s: 180, event_stall_kill_s: 1500 },
      }),
    );
    // THE ASYMMETRIC PAIR AGAIN, this time on disk and through a subprocess.
    await plant("slow", 10 * MINUTE);
    await plant("dead", 41 * MINUTE);
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  test("the wedged worker's line carries the alarm and the live one's does not", async () => {
    const r = await spawnCli(["status", "--run", RUN_ID], {
      env: { PIFLEET_RUNS_DIR: root },
    });
    expect(r.code).toBe(0);
    const lines = r.stdout.split("\n");
    const dead = lines.find((l) => l.trimStart().startsWith("dead:")) ?? "";
    const slow = lines.find((l) => l.trimStart().startsWith("slow:")) ?? "";

    // THE DEFECT, as an operator would have read it: both were `busy … up`.
    expect(dead).toContain("busy");
    expect(slow).toContain("busy");
    expect(dead).toContain("supervisor=up");
    expect(slow).toContain("supervisor=up");

    // …and the one fact that now separates them on the line.
    expect(dead).toContain("WEDGED");
    expect(dead).toContain("41m");
    expect(slow).not.toContain("WEDGED");
  });

  test("`--json` carries the verdict, the span and the window it judged against", async () => {
    // A pane is one consumer. A script asking "is anything waiting on me" must
    // not have to parse the human line to find out — the same argument
    // `transcript_activity` and `staged_task_id` are already carried on.
    const r = await spawnCli(["status", "--run", RUN_ID, "--json"], {
      env: { PIFLEET_RUNS_DIR: root },
    });
    expect(r.code).toBe(0);
    const doc = JSON.parse(r.stdout) as {
      workers: Array<{
        id: string;
        silence: {
          verdict: string;
          why: string | null;
          silent_ms: number | null;
          window_ms: { warn: number; kill: number } | null;
        };
      }>;
    };
    const by = (id: string) => doc.workers.find((w) => w.id === id)!.silence;

    expect(by("dead").verdict).toBe("wedged");
    expect(by("dead").silent_ms).toBe(41 * MINUTE);
    expect(by("slow").verdict).toBe("quiet");

    // The window is REPORTED, not just applied: a reader who disagrees with the
    // verdict can see which numbers produced it without opening `run.json`.
    expect(by("dead").window_ms).toEqual({ warn: 180_000, kill: 1_500_000 });
  });

  test("the raw fields the verdict was derived from are still carried beside it", async () => {
    // The derived field must not become the only view. A dashboard with its own
    // idea of "too long" has to be able to do its own arithmetic, and a verdict
    // that replaced its inputs would force it to reverse-engineer this one.
    const r = await spawnCli(["status", "--run", RUN_ID, "--json"], {
      env: { PIFLEET_RUNS_DIR: root },
    });
    const doc = JSON.parse(r.stdout) as {
      workers: Array<{
        id: string;
        heartbeat_at: string | null;
        transcript_activity: { entries: number; last_growth_at: string | null } | null;
      }>;
    };
    const dead = doc.workers.find((w) => w.id === "dead")!;
    expect(dead.heartbeat_at).toBe(HB);
    expect(dead.transcript_activity?.last_growth_at).toBe(
      new Date(Date.parse(HB) - 41 * MINUTE).toISOString(),
    );
  });
});
