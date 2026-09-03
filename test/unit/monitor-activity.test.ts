/**
 * The activity ladder: five states that must never collapse into two.
 *
 * ## The defect this file exists to prevent recurring
 *
 * The incumbent status pane prints `idle`, or nothing, and on the operator's own
 * fleet four of six live workers fall into "nothing".
 * `status-transcript-activity.test.ts` already argues that three facts must stay
 * apart — not measured, measured-and-still, measured-and-moving — and
 * `transcriptNote` (`status.ts:48-80`) keeps them apart correctly. **This file is
 * about the two states that argument does not reach**: Finding A's attended worker
 * that has never spoken (SRD §3.1), and the worker whose supervisor believes it is
 * live while `docker ps` does not list it (ISC-482).
 *
 * ## Why the assertions are shaped the way they are
 *
 * ISC-480 says "five renderings and no two collapse", and it says *no two collapse*
 * rather than *five correct values* because those are different assertions. Five
 * equality checks against five constants fail for a collapsed implementation, so
 * they are necessary — but they are not a statement of the requirement, which is a
 * property of the SET. Both are asserted below, and each catches what the other
 * misses: the pairwise sweep is the anti-collapse assertion, and the per-fixture
 * equalities are the anti-permutation assertion, which the sweep alone would not
 * catch — a derivation that swapped `quiet` and `active` keeps all ten pairs
 * distinct.
 *
 * ## ISC-491
 *
 * No terminal, no container, no runs directory, no fleet. Every input here is an
 * object literal and `deriveActivity` is pure, which is the entire reason
 * `src/monitor/activity.ts` takes facts rather than a worker directory.
 * `Docs/SRD-TUI-DISPATCH.md` §10 records four criteria stuck at `[~]` because their
 * probes needed a real pane; the cost of discovering that at grading time is a
 * criterion that can never go green.
 */

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_GROWTH_WINDOW_MS,
  deriveActivity,
  isAttended,
  type WorkerFacts,
} from "../../src/monitor/activity.ts";
import type { Activity } from "../../src/monitor/model.ts";

const NOW = Date.parse("2026-09-02T14:00:00.000Z");
const WINDOW = DEFAULT_GROWTH_WINDOW_MS;

/**
 * The base is an `rpc` worker with a healthy container, because that is the case
 * every other fixture is a DEPARTURE from, and a fixture built by spreading over
 * this one states its departure in the same few fields the SRD's own table uses.
 */
const rpcWorker: WorkerFacts = {
  adoptedTerminal: false,
  attendedMode: null,
  sessionPresent: false,
  transcriptActivity: null,
  phase: "idle",
  containerPresent: true,
};

const at = (iso: string, entries = 1462) => ({ entries, last_growth_at: iso });

/**
 * ISC-481, first in the file because it was written first and failed first —
 * against a module that did not exist, which is the only honest starting red for
 * a derivation this small.
 *
 * **Q1(a) is settled and MEASURED, not reasoned**: across the operator's runs
 * root, 6 live attended workers and 21 non-adopted ones separate cleanly on
 * `presentation.adopted_terminal`, the presence of `attended.json` with
 * `mode: "tui"`, and `state.json`'s `session_present`. None of those three is in
 * `state.json` alone, which is exactly why `pifleet status` cannot make this call
 * and why reading the run tree directly (D6) pays for itself.
 */
describe("ISC-481: a tui worker with an empty sessions/ is not an rpc worker", () => {
  const tuiNeverSpoken: WorkerFacts = {
    ...rpcWorker,
    adoptedTerminal: true,
    attendedMode: "tui",
  };

  test("the two fixtures do not derive the same state", () => {
    // The bare inequality IS the criterion. The equalities below say which way it
    // went; this one says only that the monitor can tell them apart at all, which
    // is precisely what the incumbent cannot do.
    expect(deriveActivity(tuiNeverSpoken, NOW, WINDOW)).not.toBe(
      deriveActivity(rpcWorker, NOW, WINDOW),
    );
  });

  test("the attended one is no-transcript and the other is rpc", () => {
    expect(deriveActivity(tuiNeverSpoken, NOW, WINDOW)).toBe("no-transcript");
    expect(deriveActivity(rpcWorker, NOW, WINDOW)).toBe("rpc");
  });

  /**
   * THE EDGE CASE, AND IT IS ON DISK RIGHT NOW.
   *
   * A worker was found with `attended.json` present and `mode: "tui"` but
   * `presentation.adopted_terminal` ABSENT. A reader that discriminates on
   * `adopted_terminal` alone calls that worker `rpc` — wrong, on real data,
   * today. The mirror is equally cheap to get wrong, so both directions are
   * pinned: either field alone is sufficient EVIDENCE of attendedness, and
   * neither alone is a sufficient TEST for it.
   */
  test("attended.json alone is enough when adopted_terminal is absent", () => {
    const facts: WorkerFacts = { ...rpcWorker, adoptedTerminal: null, attendedMode: "tui" };
    expect(deriveActivity(facts, NOW, WINDOW)).toBe("no-transcript");
    expect(deriveActivity(facts, NOW, WINDOW)).not.toBe(deriveActivity(rpcWorker, NOW, WINDOW));
  });

  test("adopted_terminal alone is enough when attended.json is missing", () => {
    const facts: WorkerFacts = { ...rpcWorker, adoptedTerminal: true, attendedMode: null };
    expect(deriveActivity(facts, NOW, WINDOW)).toBe("no-transcript");
  });

  /**
   * The discriminator pinned separately from the ladder.
   *
   * Asserting it only through `deriveActivity` would let a later refactor move
   * the OR into a caller and leave every test above green while `isAttended` —
   * which §6.2's attended column also reads — went wrong on its own.
   */
  test("isAttended considers both fields, and neither alone is required", () => {
    expect(isAttended({ adoptedTerminal: true, attendedMode: "tui" })).toBe(true);
    expect(isAttended({ adoptedTerminal: null, attendedMode: "tui" })).toBe(true);
    expect(isAttended({ adoptedTerminal: true, attendedMode: null })).toBe(true);
    expect(isAttended({ adoptedTerminal: false, attendedMode: null })).toBe(false);
    expect(isAttended({ adoptedTerminal: null, attendedMode: null })).toBe(false);
  });

  /**
   * `attended.json` exists for a worker that is not in tui mode, and `"viewer"`
   * is a REAL value on disk rather than a hypothetical: `steer` writes a record
   * with `mode: "viewer"` because a human reached into the run without a pane
   * ever being handed over, and `leaveTui` rewrites the record to `"viewer"` on
   * hand-back rather than deleting it (`mode.ts:449-471`).
   *
   * So the record's PRESENCE is a claim about the run's history and its `mode`
   * is the claim about the pane. A discriminator that tested presence would mark
   * every steered worker as attended forever — which is why this asserts the
   * same predicate `leaveTui` guards itself with at `mode.ts:459`.
   */
  test("an attended record whose mode is viewer does not make the worker attended", () => {
    expect(isAttended({ adoptedTerminal: false, attendedMode: "viewer" })).toBe(false);
    expect(deriveActivity({ ...rpcWorker, attendedMode: "viewer" }, NOW, WINDOW)).toBe("rpc");
  });

  /**
   * The one case where the two fields DISAGREE and the OR decides it: a pane
   * that was adopted and has since been handed back carries
   * `adopted_terminal: true` beside `mode: "viewer"`. It stays attended, because
   * `adopted_terminal` is a fact about the presentation that no hand-back
   * clears, and because §6.2's attended column — not this ladder — is where
   * `left_at` distinguishes "typing here now" from "typed here".
   */
  test("an adopted terminal outweighs a viewer record", () => {
    expect(isAttended({ adoptedTerminal: true, attendedMode: "viewer" })).toBe(true);
  });
});

/**
 * ISC-480. The five fixtures the criterion names, in the order it names them.
 */
describe("ISC-480: five fixtures, five states, no two collapsed", () => {
  const fixtures: readonly (readonly [string, WorkerFacts, Activity])[] = [
    ["rpc worker", rpcWorker, "rpc"],
    [
      "tui worker, no session file",
      { ...rpcWorker, adoptedTerminal: true, attendedMode: "tui" },
      "no-transcript",
    ],
    [
      "tui worker, session file, no growth",
      {
        ...rpcWorker,
        adoptedTerminal: true,
        attendedMode: "tui",
        sessionPresent: true,
        transcriptActivity: at("2026-09-02T13:49:00.000Z"),
      },
      "quiet",
    ],
    [
      "tui worker, growing now",
      {
        ...rpcWorker,
        adoptedTerminal: true,
        attendedMode: "tui",
        sessionPresent: true,
        transcriptActivity: at("2026-09-02T13:59:57.000Z"),
      },
      "active",
    ],
    ["container absent", { ...rpcWorker, containerPresent: false }, "container-gone"],
  ];

  test("each fixture derives the state the criterion names", () => {
    const derived = fixtures.map(([name, facts]) => `${name} -> ${deriveActivity(facts, NOW, WINDOW)}`);
    const expected = fixtures.map(([name, , state]) => `${name} -> ${state}`);
    expect(derived).toEqual(expected);
  });

  /**
   * The anti-collapse assertion. Ten pairs, and the failure names the offending
   * pair — "expected 5 to be 4" on a Set size tells a reader that something
   * collapsed and not WHICH two things did.
   */
  test("no two of the five derive the same state", () => {
    const collapsed: string[] = [];
    for (let i = 0; i < fixtures.length; i += 1) {
      for (let j = i + 1; j < fixtures.length; j += 1) {
        const a = fixtures[i]!;
        const b = fixtures[j]!;
        const left = deriveActivity(a[1], NOW, WINDOW);
        const right = deriveActivity(b[1], NOW, WINDOW);
        if (left === right) collapsed.push(`${a[0]} and ${b[0]} both derived ${left}`);
      }
    }
    expect(collapsed).toEqual([]);
  });

  test("the five fixtures cover the whole union, so no state is unreachable", () => {
    // A ladder with a member nothing can produce is a member that will be wrong
    // the first time something does produce it.
    const produced = new Set(fixtures.map(([, facts]) => deriveActivity(facts, NOW, WINDOW)));
    expect([...produced].sort()).toEqual([
      "active",
      "container-gone",
      "no-transcript",
      "quiet",
      "rpc",
    ]);
  });
});

/**
 * The growth window is a POLICY, not a measurement, and these tests pass it
 * explicitly for that reason — assertions written against the default would make
 * a later tuning of the constant look like a behavioural regression.
 */
describe("quiet versus active is a window around the last growth stamp", () => {
  const speaking = (iso: string | null): WorkerFacts => ({
    ...rpcWorker,
    adoptedTerminal: true,
    attendedMode: "tui",
    sessionPresent: true,
    transcriptActivity: iso === null ? { entries: 900, last_growth_at: null } : at(iso),
  });

  test("inside the window is active and outside it is quiet", () => {
    expect(deriveActivity(speaking("2026-09-02T13:59:57.000Z"), NOW, 30_000)).toBe("active");
    expect(deriveActivity(speaking("2026-09-02T13:49:00.000Z"), NOW, 30_000)).toBe("quiet");
  });

  test("the boundary is inclusive, so a stamp exactly one window old is still active", () => {
    // Stated rather than discovered. An exclusive bound flickers a worker between
    // two states on consecutive ticks when its writes land on the period.
    expect(deriveActivity(speaking("2026-09-02T13:59:30.000Z"), NOW, 30_000)).toBe("active");
    expect(deriveActivity(speaking("2026-09-02T13:59:29.999Z"), NOW, 30_000)).toBe("quiet");
  });

  /**
   * MEASURED-AND-STILL, which `transcriptNote` renders as "transcript no writes
   * yet". The poll has seen the file and never seen it grow — a supervisor that
   * started against an existing transcript (`contracts.ts:370-375`). It is quiet,
   * and calling it `no-transcript` would claim the worker has never spoken while
   * a transcript holding 900 entries says otherwise.
   */
  test("a watched file that has never grown is quiet, not no-transcript", () => {
    expect(deriveActivity(speaking(null), NOW, 30_000)).toBe("quiet");
  });

  /**
   * A supervisor whose host clock runs ahead writes a stamp in the future. `ago`
   * (`status.ts`) clamps that to `0s` rather than printing `-3s`, and this agrees
   * with it: a future stamp is "just now", which is what it is. Letting it fall
   * through to `quiet` would report a worker that is mid-turn as still.
   */
  test("a future stamp is active rather than quiet", () => {
    expect(deriveActivity(speaking("2026-09-02T14:00:07.000Z"), NOW, 30_000)).toBe("active");
  });

  /**
   * A hand-edited or truncated state file. `Date.parse` returns `NaN`, every
   * comparison against it is false, and the hazard is not a crash but a SILENT
   * landing: `NaN <= window` is false, so an unguarded derivation reaches `quiet`
   * by accident rather than by decision. It reaches it by decision.
   */
  test("an unparseable stamp is quiet, and quiet by decision rather than by NaN", () => {
    const facts: WorkerFacts = {
      ...rpcWorker,
      adoptedTerminal: true,
      attendedMode: "tui",
      sessionPresent: true,
      transcriptActivity: { entries: 12, last_growth_at: "garbage" },
    };
    expect(deriveActivity(facts, NOW, 30_000)).toBe("quiet");
  });
});

/**
 * ISC-482. The single most actionable fact this monitor can produce and nothing
 * in the fleet reports today (§3.3) — and the one most easily produced WRONGLY,
 * because "not present" and "not looked at" are the same falsy value to a
 * careless read.
 */
describe("container-gone is a finding, and only when there is something to find", () => {
  test("a live supervisor with no container in docker ps is container-gone", () => {
    expect(deriveActivity({ ...rpcWorker, containerPresent: false }, NOW, WINDOW)).toBe(
      "container-gone",
    );
  });

  /**
   * `null` is the slow clock never having completed — `Region<T>`'s `never`
   * status arriving here as an absence of fact (`model.ts:57-65`). Rendering it
   * as `container-gone` would stamp the fleet's most actionable finding on every
   * worker for the first tick of every monitor session, which is how a finding
   * stops being read.
   */
  test("a container set that was never read is not a missing container", () => {
    expect(deriveActivity({ ...rpcWorker, containerPresent: null }, NOW, WINDOW)).toBe("rpc");
  });

  test("a dead worker whose container is gone is not a finding, because nothing disagrees", () => {
    // `container-gone` is a CONTRADICTION between two sources: the supervisor
    // says live, `docker ps` says absent. When `phase` is already `dead` there is
    // no contradiction, and the phase column carries the fact on its own.
    expect(
      deriveActivity({ ...rpcWorker, phase: "dead", containerPresent: false }, NOW, WINDOW),
    ).toBe("rpc");
  });

  /**
   * The precedence question, answered explicitly because it stays invisible
   * until it is wrong: a missing container outranks the transcript ladder. A
   * worker that wrote its transcript three seconds before its container vanished
   * would otherwise render `active` — a confident liveness claim about a process
   * that is not running.
   */
  test("an absent container outranks a transcript that was growing", () => {
    const facts: WorkerFacts = {
      ...rpcWorker,
      adoptedTerminal: true,
      attendedMode: "tui",
      sessionPresent: true,
      transcriptActivity: at("2026-09-02T13:59:57.000Z"),
      containerPresent: false,
    };
    expect(deriveActivity(facts, NOW, WINDOW)).toBe("container-gone");
  });
});

/**
 * Q1(b) is NOT settled, and the union must not pretend otherwise
 * (`model.ts:99-104`). These assertions exist so that a future change adding a
 * `wedged` member has to delete a test that says in words why it must not.
 */
describe("no-transcript means has never spoken, never is stuck", () => {
  test("nine hours of silence is the same state as nine seconds of it", () => {
    const facts: WorkerFacts = { ...rpcWorker, adoptedTerminal: true, attendedMode: "tui" };
    // Nothing on disk distinguishes a worker that has never spoken from one that
    // is wedged, so no elapsed time may promote this state into a verdict. The
    // four live workers this describes had been silent for nine hours and were
    // fine. If a probe ever DOES distinguish them, this test is the thing that
    // has to be argued with first.
    const early = deriveActivity(facts, NOW, WINDOW);
    const late = deriveActivity(facts, NOW + 9 * 60 * 60 * 1000, WINDOW);
    expect(late).toBe(early);
    expect(late).toBe("no-transcript");
  });

  /**
   * A session file exists but the poll has not written `transcript_activity` yet
   * — the window between `discoverSessionPath` recording the path and the next
   * poll flushing counts (`supervisor/index.ts:1982-2020`). The file is created
   * lazily on the first assistant message (`contracts.ts:338-341`), so its
   * existence PROVES the worker spoke. Calling that `no-transcript` would state
   * the one thing the file disproves.
   */
  test("a present session file with no counters yet is quiet, not no-transcript", () => {
    const facts: WorkerFacts = {
      ...rpcWorker,
      adoptedTerminal: true,
      attendedMode: "tui",
      sessionPresent: true,
      transcriptActivity: null,
    };
    expect(deriveActivity(facts, NOW, WINDOW)).toBe("quiet");
  });
});
