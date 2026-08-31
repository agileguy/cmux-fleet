/**
 * The Phase 4 `pane_mode: tui` guards in `pifleet up` (TUI spec items 12 and 4).
 *
 * ## The risk these probe is the rpc path, not the tui one
 *
 * A tui worker has no behaviour to regress — the mode did not exist. What CAN
 * break is a guard that fires on everything: a warning every fleet prints, a
 * refusal every headless run trips over. So every describe block below carries
 * an rpc arm that must come back empty/silent, and those arms are the ones
 * worth keeping if the rest were ever cut.
 *
 * Everything here is pure and runs against temp-dir YAML — no Docker daemon, no
 * run directory, no fleet.
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stringify } from "yaml";
import { loadConfig, type LoadedConfig } from "../../src/config/load.ts";
import { EXIT } from "../../src/contracts.ts";
import { readFileSync } from "node:fs";
import { WorkerLaunchSchema, type WorkerLaunch } from "../../src/contracts.ts";
import { stripComments } from "../support/source-structure.ts";
import { sendKeyArgv as tmuxSendKeyArgv } from "../../src/backends/tmux/argv.ts";
import { sendKeyArgv as cmuxSendKeyArgv } from "../../src/backends/cmux/client.ts";
import { PANE_KEYS } from "../../src/util/pane-text.ts";
import { SEPARATOR_KEY, SUBMIT_KEY, paneKeystrokes } from "../../src/cli/commands/dispatch.ts";
import {
  assertTuiBackendPossible,
  panePresentationArgv,
  panePresentationIsAttach,
  resolveRequestedBackend,
  runIsUnattended,
  tuiWorkerIds,
  unattendedTuiWarning,
} from "../../src/cli/commands/up.ts";

const cleanups: string[] = [];
afterAll(async () => {
  for (const dir of cleanups) await rm(dir, { recursive: true, force: true }).catch(() => {});
});

/** Smallest valid document; each test overrides the pieces it is about. */
function baseDoc(): Record<string, unknown> {
  return {
    version: 2,
    name: "test-fleet",
    docker: { pi_version: "0.79.6" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "DefaultModel" },
    roles: { eng: {} },
    workers: [{ id: "w1", role: "eng" }],
  };
}

async function load(doc: unknown): Promise<LoadedConfig> {
  const dir = await mkdtemp(join(tmpdir(), "pifleet-tui-guards-"));
  cleanups.push(dir);
  const path = join(dir, "fleet.yaml");
  await writeFile(path, stringify(doc));
  return loadConfig(path);
}

describe("tuiWorkerIds resolves the mode through the merge, never off config.workers", () => {
  /**
   * THE CONTROL, and the most valuable assertion in this file. Every fleet in
   * this repository's example config and every fleet anyone has run to date is
   * this shape; if `tuiWorkerIds` ever answers non-empty here, the warning
   * below fires on every run and the refusal in `up` blocks every headless one.
   */
  test("a fleet with no tui worker anywhere resolves to no tui workers", async () => {
    const loaded = await load(baseDoc());
    expect(tuiWorkerIds(loaded, ["w1"])).toEqual([]);
  });

  test("a role-level pane_mode: tui is found", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { pane_mode: "tui" } };
    const loaded = await load(doc);
    expect(tuiWorkerIds(loaded, ["w1"])).toEqual(["w1"]);
  });

  /**
   * The merge is HONOURED rather than re-derived, and this is the arm that
   * catches a re-derivation: neither `defaults` nor the worker entry states the
   * final answer on its own. A walk of `config.workers` reading `w.pane_mode`
   * would answer `[]` for the first case (the field is on `defaults`) and
   * `["w1"]` for the second (it reads `defaults` and misses the override) —
   * wrong in BOTH directions, which is why both directions are asserted.
   */
  test("pane_mode from defaults reaches a worker that states nothing", async () => {
    const doc = baseDoc();
    doc["defaults"] = { pane_mode: "tui" };
    const loaded = await load(doc);
    expect(tuiWorkerIds(loaded, ["w1"])).toEqual(["w1"]);
  });

  test("a worker override back to rpc wins over a tui default", async () => {
    const doc = baseDoc();
    doc["defaults"] = { pane_mode: "tui" };
    doc["workers"] = [{ id: "w1", role: "eng", pane_mode: "rpc" }];
    const loaded = await load(doc);
    expect(tuiWorkerIds(loaded, ["w1"])).toEqual([]);
  });

  test("only the named launch set is resolved, and an undefined id is skipped", async () => {
    const doc = baseDoc();
    doc["roles"] = { eng: { pane_mode: "tui" }, plain: {} };
    doc["workers"] = [
      { id: "w1", role: "eng" },
      { id: "w2", role: "plain" },
    ];
    const loaded = await load(doc);
    expect(tuiWorkerIds(loaded, ["w2"])).toEqual([]);
    expect(tuiWorkerIds(loaded, ["w1", "w2"])).toEqual(["w1"]);
    // The `PIFLEET_PI_COMMAND` double: an id that exists only on the command
    // line has no role and so no pane_mode. Skipped, never thrown on.
    expect(tuiWorkerIds(loaded, ["nowhere"])).toEqual([]);
  });
});

describe("runIsUnattended", () => {
  const ttys = (stdin: boolean, stdout: boolean, stderr: boolean) => ({
    stdinIsTty: stdin,
    stdoutIsTty: stdout,
    stderrIsTty: stderr,
  });

  test("any one terminal on any one stream is evidence of a person", () => {
    // Three separate arms, because a reader redirecting two streams
    // (`pifleet up > out.txt 2> err.txt`) is a person, and an implementation
    // that only consulted stdout would call them CI.
    expect(runIsUnattended({ json: false, ...ttys(true, false, false) })).toBe(false);
    expect(runIsUnattended({ json: false, ...ttys(false, true, false) })).toBe(false);
    expect(runIsUnattended({ json: false, ...ttys(false, false, true) })).toBe(false);
  });

  test("three pipes and no --json is unattended", () => {
    expect(runIsUnattended({ json: false, ...ttys(false, false, false) })).toBe(true);
  });

  /**
   * `--json` alone, from a full terminal, is deliberately unattended: it names
   * a machine consumer. This is the OVERWARNING the function's docblock chooses
   * on purpose, pinned so that nobody "fixes" it into a silent miss.
   */
  test("--json is unattended even with every stream on a terminal", () => {
    expect(runIsUnattended({ json: true, ...ttys(true, true, true) })).toBe(true);
  });
});

describe("unattendedTuiWarning says what is given up", () => {
  /**
   * THE CONTROL. An rpc fleet in CI — three pipes, `--json`, the loudest
   * possible unattended signal — must still print nothing.
   */
  test("an unattended run with no tui worker is silent", () => {
    expect(unattendedTuiWarning({ tuiWorkers: [], unattended: true })).toBeNull();
  });

  test("a tui worker in an attended run is silent", () => {
    expect(unattendedTuiWarning({ tuiWorkers: ["w1"], unattended: false })).toBeNull();
  });

  test("a tui worker in an unattended run names the workers and each voided guarantee", () => {
    const text = unattendedTuiWarning({ tuiWorkers: ["w1", "w2"], unattended: true });
    expect(text).not.toBeNull();
    const w = text!;
    expect(w).toStartWith("warning: ");
    expect(w).toEndWith("\n");
    // The workers, by name and by count.
    expect(w).toContain("2 worker(s)");
    expect(w).toContain("w1, w2");

    /**
     * The COSTS, one assertion each. "Say what is being given up, not just
     * that something is" is the requirement, and a warning that only said
     * "unattended tui run" would pass every assertion above this block. Each
     * fragment names a behaviour this build actually has, so a future change
     * that removes one of them leaves a warning that lies.
     */
    expect(w).toContain("pane_mode_tui_is_not_auto_schedulable");
    expect(w).toContain("epoch null");
    expect(w).toContain("ui_request_timeout");
    expect(w).toContain("docker kill --signal=INT");
    expect(w).toContain("transcript-derived");
    expect(w).toContain("closing it stops the worker");
    // …and the action, which is what makes it a warning rather than a lament.
    expect(w).toContain("pifleet attach --worker w1");
  });
});

/**
 * A `tui` worker on the EFFECTIVE headless backend is refused (TUI spec item 4,
 * second half) — the residual Phase 1 declared and could not close.
 *
 * `test/unit/config.test.ts` holds the other end of this: it asserts that the
 * SCHEMA still does not refuse a document with no backend block, and its
 * comment now points here rather than at `pifleet tui --worker`. The two are
 * not in tension — `parseConfig` has no `--backend` and no `DEFAULT_BACKEND`,
 * so the check could only ever have lived where the effective value exists.
 */
describe("resolveRequestedBackend reports WHICH input answered (ISC-271)", () => {
  test("the flag beats a config, which beats the built-in default", () => {
    expect(resolveRequestedBackend({ flag: "tmux", configKind: "cmux" })).toEqual({
      kind: "tmux",
      source: "--backend",
    });
    expect(resolveRequestedBackend({ flag: undefined, configKind: "cmux" })).toEqual({
      kind: "cmux",
      source: "backend.kind",
    });
    expect(resolveRequestedBackend({ flag: undefined, configKind: null })).toEqual({
      kind: "headless",
      source: "the built-in default",
    });
  });

  /**
   * The flag wins even when it names the SAME kind the config does, and the
   * source must say so. An implementation that compared values rather than
   * consulting precedence would answer `backend.kind` here and put the wrong
   * remedy in the refusal below.
   */
  test("an explicit flag is still the flag when it agrees with the config", () => {
    expect(resolveRequestedBackend({ flag: "headless", configKind: "headless" })).toEqual({
      kind: "headless",
      source: "--backend",
    });
  });
});

describe("a tui worker on the effective headless backend is refused", () => {
  const HEADLESS_BY_FLAG = { kind: "headless", source: "--backend" } as const;
  const HEADLESS_BY_DEFAULT = { kind: "headless", source: "the built-in default" } as const;

  /**
   * THE CONTROL, and the reason this guard is dangerous if it is wrong.
   * `headless` is `DEFAULT_BACKEND` — it is what every run in this repository
   * and every test in this suite has been getting. A refusal that fired on an
   * rpc fleet would block all of them.
   */
  test("a headless run with no tui worker is not refused", () => {
    expect(() =>
      assertTuiBackendPossible({ tuiWorkers: [], backend: HEADLESS_BY_DEFAULT }),
    ).not.toThrow();
    expect(() =>
      assertTuiBackendPossible({ tuiWorkers: [], backend: HEADLESS_BY_FLAG }),
    ).not.toThrow();
  });

  test("a tui worker on cmux or tmux is not refused", () => {
    for (const kind of ["cmux", "tmux"] as const) {
      expect(() =>
        assertTuiBackendPossible({
          tuiWorkers: ["w1"],
          backend: { kind, source: "--backend" },
        }),
      ).not.toThrow();
    }
  });

  /**
   * DIRECTION ONE — `--backend headless` typed at `up`, which is the surface
   * Phase 1 named. Exit 2, because nothing is wrong with the host.
   */
  test("--backend headless with a tui worker is refused, naming the flag", () => {
    let err: unknown;
    try {
      assertTuiBackendPossible({ tuiWorkers: ["w1", "w2"], backend: HEADLESS_BY_FLAG });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    expect((err as { exitCode: number }).exitCode).toBe(EXIT.USAGE);
    const m = (err as Error).message;
    expect(m).toContain("2 worker(s)");
    expect(m).toContain("w1, w2");
    // WHICH input chose headless — without it the operator greps a fleet.yaml
    // for a word that is not in it.
    expect(m).toContain("--backend");
    // The reason, and the way out.
    expect(m).toContain("docker attach");
    expect(m).toContain("--backend cmux");
    expect(m).toContain("pane_mode: rpc");
  });

  /**
   * DIRECTION TWO, and the commoner accident by a wide margin. Phase 1's note
   * names only the flag; because `DEFAULT_BACKEND` is `headless`, a fleet.yaml
   * that adds `pane_mode: tui` and changes nothing else lands here — a document
   * the schema passes, on a backend no line of it mentions. The message has to
   * say where headless came from or it is unactionable.
   */
  test("a config that says nothing about a backend is refused, naming the default", () => {
    let err: unknown;
    try {
      assertTuiBackendPossible({ tuiWorkers: ["w1"], backend: HEADLESS_BY_DEFAULT });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(Error);
    const m = (err as Error).message;
    expect(m).toContain("the built-in default");
    // It must NOT claim the operator typed a flag they did not type.
    expect(m).not.toContain("chosen by --backend");
  });
});

// ---------------------------------------------------------------------------
// Item 4 — the pane argv and the attendance record are ONE decision
// ---------------------------------------------------------------------------

/**
 * The residual attendance gap, and the shape that closes it.
 *
 * Phase 3 built the pane routing and then said plainly what it had NOT closed:
 * the attended record is written only when an operator runs `pifleet tui`, so
 * between `up` and that command a `tui` run somebody was already typing into
 * reported as UNATTENDED. `attended/mode.ts`'s module docblock is built around
 * making exactly that impossible — both of its orderings are chosen so the
 * record can OVERCLAIM attendance and never underclaim it.
 *
 * The fix is not a second conditional in `up`. It is ONE predicate, consumed
 * twice: `panePresentationArgv` asks it to pick the argv, and the record write
 * asks it whether to fire. Two matching conditionals would close the gap today
 * and reopen it the first time one of them was edited — and the reopened gap is
 * silent, because a pane with hands on it looks no different in any artifact
 * from one without.
 *
 * These probes therefore assert the COUPLING, not just the two answers. The
 * mutation they exist to catch is "the predicate is inlined back into one of
 * the call sites", which is the refactor a reader would think harmless.
 */
describe("the pane argv and the attendance record share one predicate", () => {
  const VIEWER = ["env", "PIFLEET_RUNS_DIR=/runs", "bun", "cli", "logs"] as const;

  const rec = (paneMode: "rpc" | "tui", argv: string[]): WorkerLaunch =>
    WorkerLaunchSchema.parse({
      kind: "container",
      argv,
      container: "pifleet-r1-w1",
      image: "pifleet/pi-worker:test",
      pane_mode: paneMode,
    });

  const TUI_ARGV = ["docker", "run", "-i", "-t", "--rm", "img", "pi", "--session-id", "w1"];
  const RPC_ARGV = ["docker", "run", "-i", "--rm", "img", "pi", "--mode", "rpc", "--session-id", "w1"];

  test("a tui worker attaches, and is therefore attended", () => {
    const launch = rec("tui", TUI_ARGV);
    expect(panePresentationIsAttach({ launch })).toBe(true);
    expect(panePresentationArgv({ launch, viewer: VIEWER, runId: "r1", workerId: "w1" })).not.toBe(
      VIEWER,
    );
  });

  test("an rpc worker gets the viewer, and is therefore NOT attended", () => {
    const launch = rec("rpc", RPC_ARGV);
    expect(panePresentationIsAttach({ launch })).toBe(false);
    // Identity: the router is incapable of rebuilding the viewer argv.
    expect(panePresentationArgv({ launch, viewer: VIEWER, runId: "r1", workerId: "w1" })).toBe(
      VIEWER,
    );
  });

  /**
   * The `PIFLEET_PI_COMMAND` double: no container, therefore no TTY, therefore
   * no pane to attend. The same reading `planInterrupt(null)` settled on after
   * it was found refusing a worker that had a perfectly good control socket.
   */
  test("a worker with no launch record is neither attached nor attended", () => {
    expect(panePresentationIsAttach({ launch: null })).toBe(false);
    expect(
      panePresentationArgv({ launch: null, viewer: VIEWER, runId: "r1", workerId: "w1" }),
    ).toBe(VIEWER);
  });

  /**
   * A record whose field and argv marks disagree takes the read-only arm in
   * BOTH consequences. Refusing to guess is the established answer here
   * (`launchPaneMode` returns `"unknown"`), and the safe reading of unknown is
   * the one that changes nothing: a viewer pane, and no attendance claimed.
   */
  test("a record that disagrees with its argv attaches nothing and claims nothing", () => {
    for (const launch of [rec("tui", RPC_ARGV), rec("rpc", TUI_ARGV)]) {
      expect(panePresentationIsAttach({ launch })).toBe(false);
      expect(
        panePresentationArgv({ launch, viewer: VIEWER, runId: "r1", workerId: "w1" }),
      ).toBe(VIEWER);
    }
  });

  /**
   * THE COUPLING ITSELF, read off the source.
   *
   * The two behavioural probes above would both stay green if the predicate
   * were inlined back into `panePresentationArgv` and a separate `=== "tui"`
   * test written at the record call site. They agree today; nothing would keep
   * them agreeing. This asserts there is ONE predicate and that both consumers
   * go through it.
   */
  test("both consumers call the predicate; neither re-tests the mode itself", () => {
    const src = stripComments(
      readFileSync(join(new URL("../../", import.meta.url).pathname, "src/cli/commands/up.ts"), "utf8"),
    );
    // Exactly one definition.
    expect([...src.matchAll(/export function panePresentationIsAttach\(/g)]).toHaveLength(1);
    // The router delegates rather than testing the mode inline.
    expect(src).toMatch(/return panePresentationIsAttach\(args\)/);
    // The record write is guarded by the same predicate.
    expect(src).toMatch(/if \(panePresentationIsAttach\(\{ launch \}\)\) \{/);
    // `launchPaneMode` is consulted in ONE place in this file — the predicate.
    expect([...src.matchAll(/launchPaneMode\(/g)]).toHaveLength(1);
  });

  /**
   * The record is written through `enterTui` with the no-pane driver, not by a
   * second spelling of the attended schema, and not with a driver that would
   * respawn the pane into `docker exec … bash` — which would destroy the very
   * window the mode exists to provide.
   */
  test("the record goes through enterTui with the pane-preserving driver", () => {
    const src = stripComments(
      readFileSync(join(new URL("../../", import.meta.url).pathname, "src/cli/commands/up.ts"), "utf8"),
    );
    const call = /if \(panePresentationIsAttach\(\{ launch \}\)\) \{([\s\S]*?)\n            \}/.exec(src);
    expect(call, "the attendance write could not be located").not.toBeNull();
    const body = call![1] ?? "";
    expect(body).toContain("enterTui");
    expect(body).toContain("PANE_ALREADY_ATTENDED");
    // No hand-rolled record write beside the sanctioned one.
    expect(src).not.toContain("ATTENDED_SCHEMA");
  });
});

// ---------------------------------------------------------------------------
// The backend key vocabulary — found by a live pane, not by a test
// ---------------------------------------------------------------------------

/**
 * `shift+enter` is cmux's key name. tmux's is `S-Enter`, and tmux does not say
 * so — it exits 0 and types the unknown name as literal text.
 *
 * MEASURED 2026-08-31, one call per arm, pane read back afterwards:
 *
 *   tmux send-keys -t <pane> "shift+enter"   exit 0, pane got the LITERAL text
 *   tmux send-keys -t <pane> "S-Enter"       exit 0, pane got the KEY
 *   tmux send-keys -t <pane> "Enter"         exit 0, pane got the KEY
 *
 * The defect this catches was live in a real run: `dispatch` reported
 * `accepted: true`, the pane showed an agent working, and the brief it worked
 * from read `t-live-1shift+entershift+enterReply with exactly...` — the
 * separator typed into the prompt as text. Every exit code said success.
 *
 * Nothing at unit level could have caught it before, and that is the lesson
 * worth keeping: the dispatch probes assert the PLAN — `{kind:"key", key:
 * "shift+enter"}` — and the plan was correct. What was wrong was what one
 * backend did with a correct plan. So this probe grades the TRANSLATION, which
 * is the seam the plan crosses.
 */
describe("tmux speaks its own key names", () => {
  const CTX = { socket: null, server: null } as unknown as Parameters<typeof tmuxSendKeyArgv>[0];

  test("the fleet's key names are translated, never passed through", () => {
    expect(tmuxSendKeyArgv(CTX, "%1", "shift+enter")).toContain("S-Enter");
    expect(tmuxSendKeyArgv(CTX, "%1", "enter")).toContain("Enter");
    // The literal cmux spelling must NOT reach tmux, because tmux would type it.
    expect(tmuxSendKeyArgv(CTX, "%1", "shift+enter")).not.toContain("shift+enter");
  });

  /**
   * The refusal is the load-bearing half. An unknown key is exactly the case
   * that silently becomes typed text, so a pass-through fallback would
   * reintroduce the defect for the next key anyone adds.
   */
  test("an unknown key is refused rather than typed", () => {
    expect(() => tmuxSendKeyArgv(CTX, "%1", "ctrl+shift+f7")).toThrow(/no key name/);
    // And the message says why, so the next reader does not "fix" it by
    // restoring the fallback.
    expect(() => tmuxSendKeyArgv(CTX, "%1", "ctrl+shift+f7")).toThrow(/literal text/);
  });
});

/**
 * cmux's key vocabulary, and the guard that refused it.
 *
 * MEASURED 2026-08-31 against a real cmux surface, the rejected arm being the
 * control that proves the two backends genuinely differ:
 *
 *   cmux send-key <surface> shift+enter   rc=0  OK
 *   cmux send-key <surface> enter         rc=0  OK
 *   cmux send-key <surface> S-Enter       rc=1  invalid_params: Unknown key
 *
 * The defect was upstream of cmux: `assertCmuxValue`'s grammar
 * (`^[A-Za-z0-9][A-Za-z0-9:._-]*$`) has no `+`, so `shift+enter` was refused
 * before it was ever sent — at STEP 2 OF 29, with two lines of the operator's
 * prompt already in the pane and unwithdrawable.
 *
 * Widening that regex was refused: it guards surface ids, workspace refs and
 * status keys too, and the flag-injection hazard it exists to stop is not
 * specific to keys. A closed list also makes an unknown key FAIL rather than be
 * forwarded — which matters because tmux exits 0 on an unknown key name and
 * types it as literal text.
 */
describe("cmux keys pass their own guard, not the identifier guard", () => {
  test("shift+enter survives to the argv", () => {
    expect(cmuxSendKeyArgv("surface:25", "shift+enter")).toEqual([
      "send-key",
      "--surface",
      "surface:25",
      "shift+enter",
    ]);
  });

  test("an unknown key is still refused, and the surface id still is too", () => {
    expect(() => cmuxSendKeyArgv("surface:25", "S-Enter")).toThrow(/not a pane key/);
    expect(() => cmuxSendKeyArgv("--evil", "enter")).toThrow(/not a valid cmux identifier/);
  });

  /**
   * The plan is gated WHOLE. Text lines were already checked one layer above
   * the backend so nothing is typed if any line is untypeable; the key steps
   * were not, and a key refused mid-plan strands a half-typed prompt. Half a
   * gate only changes which kind of step does the stranding.
   */
  test("a plan containing an unsendable key is refused before any byte", () => {
    const plan = paneKeystrokes("w1", "one\ntwo\nthree");
    for (const step of plan) {
      if (step.kind === "key") expect(PANE_KEYS).toContain(step.key);
    }
    // And the separator is the measured one, not a guess.
    expect(plan.filter((s) => s.kind === "key").map((s) => (s as { key: string }).key)).toEqual([
      "shift+enter",
      "shift+enter",
      "enter",
    ]);
  });
});

/**
 * The two key constants are members of the allow-list.
 *
 * THIS is what actually holds "nothing is typed unless every step is
 * sendable", and it is written down because the runtime loop in
 * `paneKeystrokes` does NOT: deleting that loop leaves the suite green, since
 * the only keys it can ever see are these two constants. Checked, rather than
 * assumed — a guard nobody can redden is not a guard, and pretending otherwise
 * is how a decorative probe gets kept.
 *
 * A constant edited to something no backend accepts is the real failure mode,
 * and it fails here.
 */
test("the separator and submit keys are sendable keys", () => {
  expect(PANE_KEYS).toContain(SEPARATOR_KEY);
  expect(PANE_KEYS).toContain(SUBMIT_KEY);
  // And they are DIFFERENT: a separator equal to submit would end the turn
  // after the first line — the exact silent truncation this mode guards.
  expect(SEPARATOR_KEY).not.toBe(SUBMIT_KEY);
});
