/**
 * `pane_mode: tui` — the supervisor's launch and completion plane (SRD §3.5,
 * spec items 2.0, 5 and 6).
 *
 * Two kinds of probe, and the split is the point.
 *
 * The BEHAVIOURAL half grades `src/supervisor/tui.ts`, which is pure precisely
 * so that it can be graded at unit speed without Docker, a container, or a
 * terminal. The STRUCTURAL half grades `src/supervisor/index.ts`, which cannot
 * be — it is one 2000-line `main()` that spawns a process and opens a socket —
 * and where the actual risk lives.
 *
 * That second half exists because of a failure mode this project has already
 * had: a battery of probes that all call the selector directly, so a refactor
 * which stops CALLING the selector leaves every test green. `detachedDockerArgv`
 * returning the right array proves nothing about whether the supervisor invokes
 * it. The structural probes read the supervisor's source and assert the wiring,
 * which is the thing a refactor silently drops.
 *
 * **THE MOST IMPORTANT PROBE IN THIS FILE** is `an rpc worker's launch path is
 * unchanged`. The risk in this phase was never the tui path, which had no
 * behaviour to regress; it was routing both modes through the new one.
 */

import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";

import {
  TUI_POLL_MS,
  TUI_ERROR_GRACE_MS,
  TUI_QUIET_MS,
  classifyTuiTurn,
  detachedDockerArgv,
  discoverSessionPath,
  sessionFileSuffix,
  quietWindowMsFor,
  verdictForStopReason,
} from "../../src/supervisor/tui.ts";
import type { TreeEntry } from "../../src/harvest/transcript.ts";
import { stripComments } from "../support/source-structure.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const SUPERVISOR = stripComments(readFileSync(`${ROOT}src/supervisor/index.ts`, "utf8"));

/** The argv `render.ts` emits for a tui worker today, in order. */
const TUI_ARGV = [
  "docker",
  "run",
  "-i",
  "-t",
  "--rm",
  "--name",
  "pifleet-r1-eng-1",
  "--user",
  "1000:1000",
  "image:tag",
  "pi",
  "--session-id",
  "eng-1",
];

/** The same, as an `rpc` worker: identical but for the absent `-t`. */
const RPC_ARGV = TUI_ARGV.filter((a) => a !== "-t");

// ---------------------------------------------------------------------------
// detachedDockerArgv — the launch shape (spec item 2.0)
// ---------------------------------------------------------------------------

describe("detachedDockerArgv", () => {
  test("inserts -d immediately after the run subcommand", () => {
    expect(detachedDockerArgv(TUI_ARGV)).toEqual([
      "docker",
      "run",
      "-d",
      "-i",
      "-t",
      "--rm",
      "--name",
      "pifleet-r1-eng-1",
      "--user",
      "1000:1000",
      "image:tag",
      "pi",
      "--session-id",
      "eng-1",
    ]);
  });

  /**
   * The position, asserted as a position and not merely as membership.
   *
   * `toContain("-d")` would pass on an argv with `-d` appended after the image
   * name — which is not a docker flag at all, it is an argument handed to `pi`.
   * That failure does not error: the container runs in the FOREGROUND, docker
   * refuses `-t` on a piped stdin, and the operator gets `the input device is
   * not a TTY` with nothing mentioning `pane_mode`. So the claim has to be
   * about the index.
   */
  test("-d lands before the image, never after it", () => {
    const out = detachedDockerArgv(TUI_ARGV);
    expect(out.indexOf("-d")).toBe(2);
    expect(out.indexOf("-d")).toBeLessThan(out.indexOf("image:tag"));
  });

  /** Everything else survives byte for byte, in order. */
  test("changes nothing but the insertion", () => {
    const out = detachedDockerArgv(TUI_ARGV);
    expect(out.filter((a) => a !== "-d")).toEqual([...TUI_ARGV]);
    expect(out.length).toBe(TUI_ARGV.length + 1);
  });

  test("refuses an argv that is not `docker run`", () => {
    expect(() => detachedDockerArgv(["podman", "run", "-i"])).toThrow(/docker run/);
    expect(() => detachedDockerArgv(["docker", "exec", "-i"])).toThrow(/docker run/);
    expect(() => detachedDockerArgv([])).toThrow(/docker run/);
  });

  /**
   * Two detachers is the ISC-188 shape — two places deciding one thing, and a
   * later reader unable to tell which won. A second `-d` is refused rather than
   * deduplicated, because deduplicating hides the fact that it happened.
   */
  test("refuses an argv that already carries -d or --detach", () => {
    expect(() => detachedDockerArgv(["docker", "run", "-d", "img"])).toThrow(/only detacher/);
    expect(() => detachedDockerArgv(["docker", "run", "--detach", "img"])).toThrow(/only detacher/);
  });

  test("does not mutate its input", () => {
    const input = [...TUI_ARGV];
    detachedDockerArgv(input);
    expect(input).toEqual(TUI_ARGV);
  });
});

// ---------------------------------------------------------------------------
// discoverSessionPath — the transcript, without get_state (spec item 6)
// ---------------------------------------------------------------------------

describe("discoverSessionPath", () => {
  const sessions = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "pifleet-tui-"));
    await mkdir(join(dir, "sessions"), { recursive: true });
    return join(dir, "sessions");
  };

  test("the suffix is the session id, not a prefix or a bare match", () => {
    expect(sessionFileSuffix("eng-1")).toBe("_eng-1.jsonl");
  });

  test("finds the file Pi wrote under an unpredictable timestamp prefix", async () => {
    const dir = await sessions();
    const path = join(dir, "2026-08-31T10-00-00-000Z_eng-1.jsonl");
    await writeFile(path, "");
    expect(await discoverSessionPath(dir, "eng-1")).toEqual({ path, matches: 1 });
  });

  /**
   * The containment claim. `sessionId` is the worker id and the run's session
   * directory holds every worker's transcript, so a search that matched loosely
   * would hand one worker another's evidence — the exact hazard ISC-95's
   * never-glob rule exists to prevent, and the reason this glob is a SUFFIX
   * match rather than a wildcard.
   */
  test("does not match another worker's transcript", async () => {
    const dir = await sessions();
    await writeFile(join(dir, "2026-08-31T10-00-00-000Z_eng-2.jsonl"), "");
    await writeFile(join(dir, "2026-08-31T10-00-00-000Z_eng-11.jsonl"), "");
    expect(await discoverSessionPath(dir, "eng-1")).toEqual({ path: null, matches: 0 });
  });

  /**
   * A worker id that is a SUFFIX of another worker's id is the case a naive
   * `endsWith(id)` gets wrong. `_` is part of the suffix precisely for this.
   */
  test("a worker whose id ends in another's id does not collide", async () => {
    const dir = await sessions();
    const mine = join(dir, "2026-08-31T10-00-00-000Z_eng-1.jsonl");
    await writeFile(mine, "");
    await writeFile(join(dir, "2026-08-31T10-00-00-000Z_sub-eng-1.jsonl"), "");
    const found = await discoverSessionPath(dir, "eng-1");
    expect(found.path).toBe(mine);
    expect(found.matches).toBe(1);
  });

  test("a bare `_eng-1.jsonl` with no timestamp is not a candidate", async () => {
    const dir = await sessions();
    await writeFile(join(dir, "_eng-1.jsonl"), "");
    expect(await discoverSessionPath(dir, "eng-1")).toEqual({ path: null, matches: 0 });
  });

  /**
   * Two transcripts for one worker is a relaunch into the same run directory.
   * The newest is the answer AND the count is reported, so the ambiguity
   * reaches the operator's event log instead of being resolved silently.
   */
  test("with two matches the newest wins and the count is reported", async () => {
    const dir = await sessions();
    const older = join(dir, "2026-08-31T10-00-00-000Z_eng-1.jsonl");
    const newer = join(dir, "2026-08-31T11-00-00-000Z_eng-1.jsonl");
    await writeFile(older, "");
    await writeFile(newer, "");
    await utimes(older, new Date(1_000_000), new Date(1_000_000));
    await utimes(newer, new Date(2_000_000), new Date(2_000_000));
    expect(await discoverSessionPath(dir, "eng-1")).toEqual({ path: newer, matches: 2 });
  });

  /**
   * The file is created LAZILY on the first assistant message (SRD §4.2), so
   * "not there" is the expected answer for the first seconds of every worker's
   * life and must not be an error.
   */
  test("an empty or missing directory is null, not a throw", async () => {
    const dir = await sessions();
    expect(await discoverSessionPath(dir, "eng-1")).toEqual({ path: null, matches: 0 });
    expect(await discoverSessionPath(join(dir, "nope"), "eng-1")).toEqual({
      path: null,
      matches: 0,
    });
  });

  test("the search is flat — a nested file is not found", async () => {
    const dir = await sessions();
    await mkdir(join(dir, "deep"), { recursive: true });
    await writeFile(join(dir, "deep", "2026-08-31T10-00-00-000Z_eng-1.jsonl"), "");
    expect(await discoverSessionPath(dir, "eng-1")).toEqual({ path: null, matches: 0 });
  });
});

// ---------------------------------------------------------------------------
// classifyTuiTurn — completion, read off the transcript (spec item 6)
// ---------------------------------------------------------------------------

/** An assistant entry with the given stop reason, in the shape Pi writes. */
function assistant(id: string, stopReason: string | null): TreeEntry {
  return {
    type: "message",
    id,
    parentId: null,
    message: {
      role: "assistant",
      content: [{ type: "text", text: "x" }],
      ...(stopReason === null ? {} : { stopReason }),
    },
  } as unknown as TreeEntry;
}

function user(id: string): TreeEntry {
  return {
    type: "message",
    id,
    parentId: null,
    message: { role: "user", content: [{ type: "text", text: "go" }] },
  } as unknown as TreeEntry;
}

describe("classifyTuiTurn", () => {
  test("no entries at all is awaiting_start", () => {
    expect(classifyTuiTurn([])).toEqual({ phase: "awaiting_start", stopReason: null });
  });

  /**
   * A user message is not a turn starting. In this mode the user message is a
   * person typing into the pane, and it appears in the transcript immediately —
   * so treating any entry as evidence of a turn would let a dispatched epoch
   * settle on the echo of its own prompt.
   */
  test("a user message alone is still awaiting_start", () => {
    expect(classifyTuiTurn([user("e1")])).toEqual({ phase: "awaiting_start", stopReason: null });
  });

  test("a toolUse stop is in_flight — more is coming", () => {
    expect(classifyTuiTurn([assistant("e1", "toolUse")])).toEqual({
      phase: "in_flight",
      stopReason: "toolUse",
    });
  });

  /**
   * ISC-1105 — the terminating-report exception, in the shapes read off a real
   * `rev-ctx-1` transcript from the first live Phase A run.
   *
   * `submit_report` returns `terminate: true`, which skips Pi's follow-up call,
   * so the transcript's last assistant message stays `toolUse` for ever. Read as
   * `in_flight` it resets the quiet clock on every poll and the epoch can only
   * end at its deadline — three seats delivered complete reports and all three
   * settled `timed_out`, and a lens that did not succeed is never published as a
   * reply, so the reviews were discarded in silence.
   */
  function toolCallAssistant(id: string, callIds: readonly string[]): TreeEntry {
    return {
      type: "message",
      id,
      parentId: null,
      message: {
        role: "assistant",
        stopReason: "toolUse",
        content: callIds.map((c) => ({ type: "toolCall", id: c, name: "submit_report" })),
      },
    } as unknown as TreeEntry;
  }
  function submitEntry(id: string): TreeEntry {
    return {
      type: "custom",
      id,
      parentId: null,
      customType: "pifleet.submit/v1",
      data: { schema: "pifleet.submit/v1", task_id: "T-1", epoch: 1, status: "success" },
    } as unknown as TreeEntry;
  }
  function toolResult(id: string, callId: string): TreeEntry {
    return {
      type: "message",
      id,
      parentId: null,
      message: { role: "toolResult", toolCallId: callId, toolName: "submit_report", content: [] },
    } as unknown as TreeEntry;
  }

  test("a toolUse stop that DELIVERED a report has ended — no follow-up is coming", () => {
    expect(
      classifyTuiTurn([
        toolCallAssistant("e1", ["call_a"]),
        submitEntry("e2"),
        toolResult("e3", "call_a"),
      ]),
    ).toEqual({ phase: "ended", stopReason: "toolUse" });
  });

  /**
   * `terminate` is batch-conditional — effective only when EVERY finalized
   * result in the batch is terminating — so a `submit_report` called alongside a
   * slow tool still gets its follow-up and is genuinely still working. Without
   * the answered-calls half, `TUI_QUIET_MS` (2s) would settle such a turn while
   * a long `bash` was still running.
   */
  test("a delivered report with an unanswered sibling call is still in_flight", () => {
    expect(
      classifyTuiTurn([
        toolCallAssistant("e1", ["call_a", "call_slow"]),
        submitEntry("e2"),
        toolResult("e3", "call_a"),
      ]),
    ).toEqual({ phase: "in_flight", stopReason: "toolUse" });
  });

  /**
   * A REFUSED `submit_report` appends no entry and returns no `terminate`, so Pi
   * does make the follow-up call. Keying this on the tool NAME rather than the
   * entry would settle a refusal as though it had delivered.
   */
  test("a toolUse stop with no submit entry stays in_flight", () => {
    expect(
      classifyTuiTurn([toolCallAssistant("e1", ["call_a"]), toolResult("e2", "call_a")]),
    ).toEqual({ phase: "in_flight", stopReason: "toolUse" });
  });

  /**
   * ISC-1107 — a queued user message is a turn that has not happened yet.
   *
   * Layer 3's nag is delivered as a `followUp`, so it lands in the transcript as
   * a user message after the assistant stopped. Reading only the last ASSISTANT
   * message misses it, and the epoch settled 1.99s later — before any model
   * could answer. Measured: nag at 19:10:40, settle at 19:10:41.996, model
   * replied at 19:10:44 and was refused `No task is live`.
   */
  test("a user message AFTER the last assistant message is in_flight", () => {
    expect(classifyTuiTurn([assistant("e1", "stop"), user("e2")])).toEqual({
      phase: "in_flight",
      stopReason: null,
    });
  });

  /**
   * The ordinary case must not move: the auto-trigger IS a user message, and it
   * always precedes the assistant messages of the turn it started. Reading "any
   * user message" rather than "one after the last assistant" would make every
   * dispatched epoch permanently in_flight.
   */
  test("a user message BEFORE the last assistant message still ends the turn", () => {
    expect(classifyTuiTurn([user("e1"), assistant("e2", "stop")])).toEqual({
      phase: "ended",
      stopReason: "stop",
    });
  });

  /** A tool result is not a user message — it is the turn continuing normally. */
  test("a toolResult after the last assistant message does not make it in_flight", () => {
    expect(
      classifyTuiTurn([assistant("e1", "stop"), toolResult("e2", "call_a")]),
    ).toEqual({ phase: "ended", stopReason: "stop" });
  });

  /** The entry must belong to THIS batch, not to an earlier delivered epoch. */
  test("a submit entry BEFORE the last assistant message does not end the turn", () => {
    expect(
      classifyTuiTurn([
        submitEntry("e0"),
        toolCallAssistant("e1", ["call_a"]),
        toolResult("e2", "call_a"),
      ]),
    ).toEqual({ phase: "in_flight", stopReason: "toolUse" });
  });

  test("a clean stop ends the turn", () => {
    expect(classifyTuiTurn([assistant("e1", "endTurn")])).toEqual({
      phase: "ended",
      stopReason: "endTurn",
    });
  });

  test("an absent stopReason ends the turn, with null", () => {
    expect(classifyTuiTurn([assistant("e1", null)])).toEqual({
      phase: "ended",
      stopReason: null,
    });
  });

  /**
   * The LAST assistant message decides, not the first and not any of them.
   * A turn is a tool call, a result, another assistant message; reading the
   * first would settle at the first tool call, and reading "any ended" would
   * settle mid-turn on every single one.
   */
  test("the LAST assistant message decides", () => {
    expect(
      classifyTuiTurn([assistant("e1", "endTurn"), user("e2"), assistant("e3", "toolUse")]),
    ).toEqual({ phase: "in_flight", stopReason: "toolUse" });
    expect(
      classifyTuiTurn([assistant("e1", "toolUse"), assistant("e2", "endTurn")]),
    ).toEqual({ phase: "ended", stopReason: "endTurn" });
  });

  test("aborted and error are ENDED phases — they stopped, badly", () => {
    expect(classifyTuiTurn([assistant("e1", "aborted")]).phase).toBe("ended");
    expect(classifyTuiTurn([assistant("e1", "error")]).phase).toBe("ended");
  });

  /**
   * The caller slices from the dispatch baseline, so this function must be
   * total over whatever slice it is handed. Passing the WHOLE file is the
   * caller's bug, not this function's, and is guarded structurally below.
   */
  test("a non-string stopReason is read as absent, not crashed on", () => {
    const weird = {
      type: "message",
      id: "e1",
      parentId: null,
      message: { role: "assistant", content: [], stopReason: 7 },
    } as unknown as TreeEntry;
    expect(classifyTuiTurn([weird])).toEqual({ phase: "ended", stopReason: null });
  });
});

// ---------------------------------------------------------------------------
// verdictForStopReason
// ---------------------------------------------------------------------------

describe("verdictForStopReason", () => {
  test("aborted, error and length each keep their own verdict", () => {
    expect(verdictForStopReason("aborted").verdict).toBe("aborted");
    expect(verdictForStopReason("error").verdict).toBe("failed");
    expect(verdictForStopReason("length").verdict).toBe("unknown");
    // ISC-1105. Reachable only via `terminatedBySubmit`; carries its own reason
    // so a delivered turn is distinguishable from a merely quiet one.
    expect(verdictForStopReason("toolUse")).toEqual({
      verdict: "success",
      reason: "transcript_terminating_report",
    });
  });

  /**
   * A clean stop is `success`, and this is the deliberate divergence from
   * `harvest/transcript.ts`'s `reconstruct`, which answers `unknown` for the
   * same input. The two are answering different questions — see the docblock
   * on `verdictForStopReason`. Pinned so that "make them consistent" is a
   * decision someone takes on purpose rather than a tidy-up that quietly makes
   * every tui task settle `unknown`.
   */
  test("a clean stop is success, not unknown", () => {
    expect(verdictForStopReason("endTurn")).toEqual({
      verdict: "success",
      reason: "transcript_quiesced",
    });
    expect(verdictForStopReason(null).verdict).toBe("success");
  });

  test("every reason is a distinct, greppable string", () => {
    const reasons = ["aborted", "error", "length", "endTurn"].map(
      (s) => verdictForStopReason(s).reason,
    );
    expect(new Set(reasons).size).toBe(reasons.length);
  });
});

/**
 * An `error` stop is the one reading that gets a longer window, because it is
 * the one reading the worker can leave on its own.
 *
 * WHAT WAS BROKEN, on run `2026-09-04T00-26-46Z-1002`. A tester's provider
 * dropped three turns in a row — assistant entries carrying a `thinking` part
 * and nothing else, no tool call, no text. Pi retried through all of them and
 * the worker finished cleanly 18 seconds later, having run the suite and
 * written its envelope. The supervisor settled it `failed` at 00:28:43.537,
 * inside a 3.271s gap between the first error entry and the next one, because
 * the 2s window expired in it. Harvest then ran 15 seconds before the envelope
 * existed and reported "no result envelope"; `wait` exited 7.
 *
 * `quietWindowMsFor` is the repair, and the shape of it matters: not a better
 * guess at whether the error was fatal — nothing in the transcript can say —
 * but enough time for the worker to disprove it. Growth already resets the
 * clock, so one retry entry is enough.
 *
 * CONTROL ARMS. "the error window is longer" is also satisfied by making EVERY
 * window 30s, which would charge every clean task 28 extra seconds of latency;
 * the second test pins the other branch. And "there is a window at all" is
 * satisfied by any positive number, so the third measures it against the gap
 * that actually caused the settle rather than against nothing.
 */
describe("an error stop is retried out of, not ended on", () => {
  test("an error stop waits on the long grace", () => {
    expect(quietWindowMsFor("error")).toBe(TUI_ERROR_GRACE_MS);
  });

  test("every other stop reason still settles on the short window", () => {
    for (const r of ["stop", "endTurn", "aborted", "length", "toolUse", null]) {
      expect(quietWindowMsFor(r)).toBe(TUI_QUIET_MS);
    }
  });

  test("the grace outlasts the gap that produced the false failure", () => {
    // 3.271s: 00:28:41.460 -> 00:28:44.731 on the run above. A grace that did
    // not clear this by a wide margin would settle the same run the same way
    // on a slightly slower retry.
    expect(TUI_ERROR_GRACE_MS).toBeGreaterThan(3_271 * 5);
    expect(TUI_ERROR_GRACE_MS).toBeGreaterThan(TUI_QUIET_MS);
  });

  test("the verdict an error stop eventually gets is unchanged", () => {
    // The window says WHEN it is believed. What it means, once the worker has
    // had its chance and stayed quiet, is still a failure.
    expect(verdictForStopReason("error")).toEqual({
      verdict: "failed",
      reason: "transcript_stop_error",
    });
  });
});

describe("the polling constants", () => {
  /**
   * The quiet window must be several polls wide or it is not a window at all:
   * a single poll's worth would settle on the first tick that saw no growth,
   * which is the mid-write race the window exists to survive.
   */
  test("the quiet window spans more than one poll", () => {
    expect(TUI_QUIET_MS).toBeGreaterThan(TUI_POLL_MS * 2);
  });
});

// ---------------------------------------------------------------------------
// THE WIRING — structural probes on the supervisor itself.
//
// Everything above proves the pure functions are right. Nothing above proves
// the supervisor CALLS them, which is the half a refactor drops.
// ---------------------------------------------------------------------------

describe("the supervisor branches on pane_mode", () => {
  /**
   * THE MOST IMPORTANT PROBE IN THIS FILE.
   *
   * An `rpc` worker's launch must be untouched by all of this. The failure this
   * guards is not a wrong tui path — that path had no behaviour to regress — it
   * is a refactor that routes BOTH modes through the new one, which would take
   * every existing worker's control plane out at once.
   *
   * Three separate claims, because they fail separately:
   *   1. the argv an rpc worker runs is `launch.argv`, used verbatim;
   *   2. the detacher is reached only through the mode test; and
   *   3. the RPC client is still constructed when the mode is not tui.
   */
  test("an rpc worker's launch path is unchanged", () => {
    // 1. The verbatim argv survives, and the detacher is on the other arm of a
    //    conditional whose test is `tuiMode`.
    expect(SUPERVISOR).toMatch(
      /cmd\s*=\s*tuiMode\s*\?\s*detachedDockerArgv\(launch\.argv\)\s*:\s*launch\.argv;/,
    );
    // 2. `detachedDockerArgv` is called EXACTLY once in the whole supervisor,
    //    so there is no second, unguarded route to it.
    expect([...SUPERVISOR.matchAll(/detachedDockerArgv\(/g)]).toHaveLength(1);
    // 3. The client is still built on the non-tui arm. `tuiMode ? null : new
    //    RpcClient(` — if this inverts, every rpc worker loses its control
    //    plane and every tui worker gets one it cannot use.
    expect(SUPERVISOR).toMatch(/tuiMode\s*\?\s*null\s*:\s*new RpcClient\(/);
  });

  /**
   * The mode is read from the LAUNCH RECORD and from nothing else.
   *
   * `argv.includes("-t")` would "work" and is the shape this refuses: a flag is
   * evidence of a decision, not the decision. `-t` can arrive from
   * `docker.extra_args`, can be spelled `--tty`, and could one day be right for
   * an rpc worker — every one of those turns a string search into a supervisor
   * that picks the wrong launch path.
   */
  test("tuiMode comes from launch.pane_mode, never from sniffing the argv", () => {
    expect(SUPERVISOR).toMatch(/const tuiMode = launch !== null && launch\.pane_mode === "tui";/);
    expect(SUPERVISOR).not.toMatch(/argv\.includes\(\s*"-t"\s*\)/);
    expect(SUPERVISOR).not.toMatch(/includes\(\s*"--tty"\s*\)/);
  });

  /**
   * A zero exit from `docker run -d` must not be a death.
   *
   * Without this branch every tui worker would, within a second of starting,
   * write `phase: "dead"` and settle any live epoch `failed:worker_died` while
   * the container ran on — alive in Docker and dead in every artifact the fleet
   * reads. `code === 0` specifically, because a NON-zero exit means no
   * container was started and is a real death.
   */
  test("a clean docker-run-d exit is a hand-off, not a worker death", () => {
    expect(SUPERVISOR).toMatch(/if \(tuiMode && code === 0\) \{/);
    // And it returns before the death bookkeeping, rather than falling through.
    const branch = /if \(tuiMode && code === 0\) \{([\s\S]*?)\n    \}/.exec(SUPERVISOR);
    expect(branch, "the tui hand-off branch could not be located").not.toBeNull();
    const body = branch![1] ?? "";
    expect(body).toContain("return;");
    // `state.exit` means "the worker exited". The docker CLI exiting is not
    // that, and recording it there would assert a clean shutdown that has not
    // happened.
    expect(body).not.toContain("state.exit");
    expect(body).not.toContain('state.phase = "dead"');
  });

  /**
   * No prompt, no ack fence (spec item 5).
   *
   * The dispatch case must refuse BEFORE `em.allocate`, so a refused dispatch
   * burns no epoch. Asserted by source ORDER: the guard's return has to precede
   * the allocation, and `toContain` on both would pass with them the wrong way
   * round.
   *
   * **SCOPED TO THE `dispatch` CASE, and it has to be since D6 added a second
   * allocator.** `handleStage` allocates too — deliberately, that is the whole
   * of D6 — so a file-wide `indexOf` no longer asks the question this test
   * means. It would answer "is the FIRST allocation anywhere in the file after
   * the guard", which happens to be true today only because `handleStage` sits
   * below `main()`, and would flip red on a reordering that changed nothing
   * about dispatch. Cutting the case out first makes the claim be about the
   * route it names.
   */
  test("dispatch refuses a tui worker before any epoch is allocated", () => {
    const from = SUPERVISOR.indexOf('case "dispatch": {');
    expect(from, "the dispatch case could not be located").toBeGreaterThan(-1);
    // Up to the next case label, so nothing after the arm can satisfy either
    // half of the ordering claim.
    const to = SUPERVISOR.indexOf('case "stage": {', from);
    expect(to, "the case following dispatch could not be located").toBeGreaterThan(from);
    const dispatchCase = SUPERVISOR.slice(from, to);

    const guard = dispatchCase.indexOf('reason = "pane_mode_tui_has_no_rpc_dispatch"');
    const allocate = dispatchCase.indexOf("em.allocate(envelope.task_id");
    expect(guard, "the tui refusal is not in the dispatch case").toBeGreaterThan(-1);
    expect(allocate, "the dispatch case allocates nowhere").toBeGreaterThan(-1);
    expect(guard).toBeLessThan(allocate);
  });

  /**
   * Every `client.send` in the file is either guarded or optional-chained.
   *
   * This is the probe that survives a future edit. A new `client.send("...")`
   * added on an unguarded path would compile only if someone silenced the null
   * — with `!` or a cast — and this catches exactly that, by asserting the
   * codebase contains no non-null assertion on `client`.
   */
  test("no call site silences the null client with an assertion or a cast", () => {
    expect(SUPERVISOR).not.toMatch(/client!/);
    expect(SUPERVISOR).not.toMatch(/client as RpcClient/);
  });

  /**
   * The completion plane is wired, not merely written.
   *
   * `src/supervisor/tui.ts` exporting a correct `classifyTuiTurn` proves
   * nothing about whether anything polls a transcript. These four assert the
   * loop exists, is armed only for tui, slices from the baseline, and settles
   * through the SAME `settle()` the rpc path uses.
   */
  test("the transcript poll is armed only for a tui worker", () => {
    expect(SUPERVISOR).toMatch(/const transcriptPoll[\s\S]{0,80}!tuiMode\s*\n?\s*\?\s*null/);
  });

  test("the turn is read from entries sliced at the epoch's baseline", () => {
    expect(SUPERVISOR).toMatch(
      /classifyTuiTurn\(tuiReader\.entries\.slice\(tuiBaselineCount\)\)/,
    );
    // Not the whole file. A tui session is long-lived and a person may have
    // driven turns through the pane before any dispatch; folding over
    // everything would settle epoch 1 on a turn that predates it.
    expect(SUPERVISOR).not.toMatch(/classifyTuiTurn\(tuiReader\.entries\)/);
  });

  /**
   * Activity is recorded ABOVE the epoch gate, and the position is the fix.
   *
   * The console read `tick-1: idle task=- supervisor=up` beside a pane that was
   * mid-turn, because everything below `const live = em.live` is EPOCH work and
   * an attended pane has no epoch — `dispatch` refuses the socket route for a
   * tui worker, so `em.live` is null on every poll of the workers this field
   * exists for. Recorded below the gate it would be written for exactly the
   * workers that already report their state some other way, and never for the
   * ones that do not.
   *
   * `tui-transcript-activity.test.ts` is the behavioural half and is what
   * actually caught the misplacement; this states the property in the file it
   * constrains, so a future reordering is red in the fast suite too.
   */
  test("transcript activity is recorded before the epoch gate, not after it", () => {
    const loop = /const transcriptPoll[\s\S]*?\}, TUI_POLL_MS\);/.exec(SUPERVISOR);
    expect(loop, "the transcript poll could not be located").not.toBeNull();
    const body = loop![0];

    const write = body.indexOf("state.transcript_activity = {");
    const gate = body.indexOf("const live = em.live;");
    expect(write, "nothing in the poll writes state.transcript_activity").toBeGreaterThan(-1);
    expect(gate, "the epoch gate could not be located").toBeGreaterThan(-1);
    expect(
      write,
      "state.transcript_activity is written below `const live = em.live` — for a worker a " +
        "person types into, em.live is always null, so it would never be written at all.",
    ).toBeLessThan(gate);

    /**
     * And it is FLUSHED — asserted HERE because nothing behavioural can.
     *
     * Deleting the flush was mutated and the integration probe stayed GREEN:
     * the heartbeat writes the whole state file every `HEARTBEAT_MS` (250 ms),
     * faster than this poll's 500 ms, so the field reaches disk either way.
     * That makes the call a deliberate redundancy rather than a load-bearing
     * one, and a redundancy no test names is a line the next reader deletes as
     * dead. What it buys is that this field's durability does not depend on a
     * different interval's body staying unconditional.
     */
    expect(body.slice(write)).toContain("void flushState();");
  });

  /**
   * The write is conditional, because the poll is not.
   *
   * `flushState` is a tmp + fsync + rename + directory fsync of the whole state
   * file, and the poll runs every `TUI_POLL_MS` — 500 ms. Unconditional, this
   * would be two durable writes a second for the life of every attended run,
   * to record that nothing changed.
   */
  test("the state file is written only when the entry count moves", () => {
    expect(SUPERVISOR).toMatch(/if \(seen === null \|\| seen\.entries !== count\) \{/);
    // `grew`, not `entries !== count`, dates the growth: a count that went DOWN
    // is a different transcript, and dating it would report a shrinking file as
    // activity.
    expect(SUPERVISOR).toMatch(/last_growth_at: grew \? isoNow\(\)/);
  });

  test("a transcript-derived completion settles through the one settle()", () => {
    const loop = /const transcriptPoll[\s\S]*?\}, TUI_POLL_MS\);/.exec(SUPERVISOR);
    expect(loop, "the transcript poll could not be located").not.toBeNull();
    const body = loop![0];
    expect(body).toContain("await settle(verdict, reason)");
    expect(body).toContain("verdictForStopReason");
    expect(body).toContain("discoverSessionPath");
    // A second settlement path would produce a differently-shaped run directory
    // for the same event — no task record, no fence, no quiesce sample.
    expect(body).not.toContain("writeTaskRecord");
    expect(body).not.toContain("em.settle(");
  });

  /**
   * The quiet window is measured on the monotonic clock (ISC-155).
   *
   * `clock.test.ts` greps this file for `Date.now()` and is the primary guard;
   * this states the positive form, so that deleting the loop's `Stopwatch`
   * in favour of something else that is merely not `Date.now()` is still red.
   */
  test("the quiet window is a Stopwatch, not a wall-clock subtraction", () => {
    expect(SUPERVISOR).toMatch(/tuiQuiet\s*=\s*new Stopwatch\(\)/);
    expect(SUPERVISOR).toMatch(/tuiQuiet\.elapsedMs\(\)\s*<\s*quietNeededMs/);
  });

  /**
   * A tui supervisor must tear itself down.
   *
   * `onChildExit` returns early at launch and never fires again, so the rpc
   * path's hand-off — close stdin, child dies, onChildExit deregisters and
   * exits — cannot happen. Without this block `pifleet down` leaves a
   * supervisor spinning on its heartbeat, still registered, still holding its
   * control socket, with a state.json that still looks healthy.
   */
  test("shutdown deregisters and exits for a tui worker", () => {
    const block = /if \(tuiMode\) \{[\s\S]*?process\.exit\(0\);/.exec(SUPERVISOR);
    expect(block, "the tui shutdown teardown could not be located").not.toBeNull();
    const body = block![0];
    expect(body).toContain("deregister_worker");
    expect(body).toContain("server.stop()");
    expect(body).toContain("clearInterval(heartbeat)");
    expect(body).toContain("clearInterval(transcriptPoll)");
  });
});

// ---------------------------------------------------------------------------
// The other end of the wire
// ---------------------------------------------------------------------------

/**
 * `up` WRITES the mode the supervisor reads. Found by a surviving mutation.
 *
 * Every probe above this line grades the READER: the supervisor branches on
 * `launch.pane_mode`, reaches the detacher only through that test, and keeps
 * the RPC client on the other arm. Not one of them grades the WRITER. Deleting
 * `pane_mode: w.paneMode` from `materialize.ts` — the single line that puts the
 * mode on the record at all — left the entire unit suite green, `supervisor-
 * tui.test.ts` and `materialize.test.ts` included, 82 tests passing on a fleet
 * that could no longer launch a TUI.
 *
 * It is silent rather than loud because `WorkerLaunchSchema` DEFAULTS the field
 * to `"rpc"`, and that default is correct — a record written before the field
 * existed describes an rpc worker and must keep parsing. The cost is that a
 * missing write is indistinguishable from an old record: every tui worker
 * would launch in the foreground with `-t` on its argv and die on `the input
 * device is not a TTY`, and nothing in the failure would name `pane_mode`.
 *
 * So this reads the record BACK off disk rather than asserting on the object
 * that built it. `WorkerLaunchSchema.parse` runs between the two, which is
 * where the default is applied — an assertion on the in-memory literal would
 * pass without ever proving the field survives the round trip that the
 * supervisor actually performs.
 *
 * Both directions, because one alone is half a probe: a writer hard-coded to
 * `"tui"` passes the tui case, and the default passes the rpc case with no
 * writer at all.
 */
describe("the launch record carries the mode up resolved", () => {
  test("a tui worker's record says tui, and a default worker's says rpc", async () => {
    const { runPaths, workerPaths } = await import("../../src/run/paths.ts");
    const { materializeWorkerInputs } = await import("../../src/run/materialize.ts");
    const { readWorkerLaunch } = await import("../../src/run/state.ts");
    const { parseConfig } = await import("../../src/config/load.ts");
    const { stringify } = await import("yaml");

    const dir = await mkdtemp(join(tmpdir(), "pifleet-panemode-"));
    const runsDir = join(dir, "runs");
    // `materializeWorkerInputs` guards its writes against `runsRoot()`, so the
    // environment has to name the same root this test uses. Restored after.
    const prev = process.env["PIFLEET_RUNS_DIR"];
    const prevSkills = process.env["PIFLEET_SKILLS_DIR"];
    process.env["PIFLEET_RUNS_DIR"] = runsDir;
    delete process.env["PIFLEET_SKILLS_DIR"];
    try {
      await mkdir(join(dir, "roles"), { recursive: true });
      await writeFile(join(dir, "roles", "eng.md"), "Engineer role briefing.\n");

      const path = join(dir, "fleet.yaml");
      await writeFile(
        path,
        stringify({
          version: 2,
          name: "pane-mode-fixture",
          docker: { pi_version: "0.79.6" },
          run: { repo: ".", budget: { tokens_ceiling: 1_000_000 } },
          llm: { model: "FixtureModel" },
          roles: { eng: { append_system_prompt_file: "./roles/eng.md" } },
          workers: [
            // The tui worker is named first so a writer that reads the wrong
            // element of the array cannot pass by luck of ordering.
            { id: "tui-1", role: "eng", pane_mode: "tui" },
            { id: "rpc-1", role: "eng" },
          ],
        }),
      );
      const loaded = await parseConfig(await Bun.file(path).text(), path);
      const run = runPaths("pm-run", runsDir);
      await mkdir(run.root, { recursive: true });
      await materializeWorkerInputs(loaded, run, ["tui-1", "rpc-1"], async () => {}, {
        writeLaunchRecord: true,
      });

      const tui = await readWorkerLaunch(workerPaths(run, "tui-1"));
      const rpc = await readWorkerLaunch(workerPaths(run, "rpc-1"));
      expect(tui, "no launch record was written for tui-1").not.toBeNull();
      expect(rpc, "no launch record was written for rpc-1").not.toBeNull();
      expect(tui!.pane_mode).toBe("tui");
      expect(rpc!.pane_mode).toBe("rpc");

      // And the two halves of the launch agree. This is the disagreement the
      // supervisor cannot detect and cannot survive: `-t` with a foreground
      // spawn is `the input device is not a TTY`, and a detached spawn without
      // `-t` is a container with no pseudo-TTY and no Pi TUI inside it.
      expect(tui!.argv).toContain("-t");
      expect(rpc!.argv).not.toContain("-t");
    } finally {
      if (prev === undefined) delete process.env["PIFLEET_RUNS_DIR"];
      else process.env["PIFLEET_RUNS_DIR"] = prev;
      if (prevSkills === undefined) delete process.env["PIFLEET_SKILLS_DIR"];
      else process.env["PIFLEET_SKILLS_DIR"] = prevSkills;
    }
  }, 30_000);
});
