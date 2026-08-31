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
  TUI_QUIET_MS,
  classifyTuiTurn,
  detachedDockerArgv,
  discoverSessionPath,
  sessionFileSuffix,
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
   */
  test("dispatch refuses a tui worker before any epoch is allocated", () => {
    const guard = SUPERVISOR.indexOf('reason = "pane_mode_tui_has_no_rpc_dispatch"');
    const allocate = SUPERVISOR.indexOf("em.allocate(envelope.task_id");
    expect(guard).toBeGreaterThan(-1);
    expect(allocate).toBeGreaterThan(-1);
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
    expect(SUPERVISOR).toMatch(/tuiQuiet\.elapsedMs\(\)\s*<\s*TUI_QUIET_MS/);
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
