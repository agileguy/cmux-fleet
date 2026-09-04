/**
 * The `operations` console's pane plan.
 *
 * These assertions are about FLAGS AND PATHS, which is the whole of what this
 * feature is: three strings typed into three shells. There is no behaviour
 * underneath to fall back on, so a wrong flag is not a degraded console, it is
 * a pane that dies on its first line while the workspace around it looks
 * correctly built.
 *
 * Every claim here was reddened by mutating the source and re-running, not by
 * reading it. The three that matter most, and what each was proved against:
 *
 * - **the git pane follows the INVOCATION directory** — swapped `watchDir` for
 *   `repoRoot` in `operationsPanes` and this suite went red. Without it, an
 *   operator standing in another repository gets cmux-fleet's branch reported
 *   to them as if it were their own.
 * - **pane 1 does not exit** — replaced `;` with `&&` before `exec $SHELL -i`
 *   and the suite went red. With `&&`, a fleet that refuses admission closes
 *   the pane and takes its own error message with it.
 * - **the git pane is a loop, not `watch(1)`** — replaced the loop with a
 *   `watch` line and the suite went red. `watch` is procps; macOS has none, so
 *   that pane would fail on tick one.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { assertCmuxText } from "../../src/backends/cmux/client.ts";
import {
  DEFAULT_OPERATIONS_WORKERS,
  OPERATIONS_TOP_FRACTION,
  OPERATIONS_WORKSPACE,
  monitorPaneCommand,
  operationsPanes,
  pifleetCommand,
} from "../../src/backends/cmux/operations-plan.ts";

const REPO = "/Users/x/repos/cmux-fleet";
const CWD = "/Users/x/repos/somewhere-else";

const plan = (over: Partial<Parameters<typeof operationsPanes>[0]> = {}) =>
  operationsPanes({ repoRoot: REPO, watchDir: CWD, ...over });

/**
 * Panes BY TITLE, never by index.
 *
 * The console's shape has changed twice — three panes to four, and the agent
 * pane from the top half to the top-right — and each time every positional
 * assertion in this file broke at once while testing nothing new. A title is
 * what the pane IS; its index is where it happened to land.
 */
const paneNamed = (title: string, over: Partial<Parameters<typeof operationsPanes>[0]> = {}) => {
  const found = plan(over).find((p) => p.title === title);
  if (found === undefined) throw new Error(`no pane titled ${title}`);
  return found;
};

describe("the workspace identity", () => {
  test("is the literal name the idempotency check matches on", () => {
    // Both `scripts/operations` and `findOperations` read this constant, so it
    // cannot drift between the creator and the finder — but a rename would
    // orphan every console already open, so it is pinned.
    expect(OPERATIONS_WORKSPACE).toBe("operations");
  });
});

describe("the pane set", () => {
  test("is exactly three panes, in creation order", () => {
    // Order is contract: pane 1 consumes the workspace's initial surface and is
    // where the operator lands.
    expect(plan().map((p) => p.title)).toEqual(["observer", "monitor", "ticketing"]);
  });

  test("the monitor spans the WHOLE bottom, and the agents share the top", () => {
    /*
     * The requested shape:
     *
     *   +---------------+---------------+
     *   |   ticketing   |   observer    |
     *   +-------------------------------+
     *   |            monitor            |
     *   +-------------------------------+
     *
     * **Creation order is the whole of why this works, and it is not reading
     * order.** The FIRST split decides the major axis. The monitor is built
     * SECOND so that split is `down` and the bottom spans the full width;
     * `ticketing` then divides the top half. Built third — reading order — the
     * monitor could only ever split one column, because by then the surface is
     * already divided left/right and nothing spans both. That was the first
     * version and it put the monitor in the bottom-left quarter.
     *
     * A directions-only assertion cannot catch it: `[null, "down", "left"]` and
     * `[null, "left", "down"]` are the same three values in a different order
     * and produce completely different consoles, which is why the ANCHORS are
     * asserted in `operations-workspace.test.ts` as well.
     */
    expect(plan().map((p) => p.title)).toEqual(["observer", "monitor", "ticketing"]);
    expect(plan().map((p) => p.split)).toEqual([null, "down", "left"]);
    // `ticketing` cannot use the default anchor: the pane before it is the
    // monitor, and splitting that would put it in the bottom row.
    expect(paneNamed("ticketing").splitFrom).toBe(0);
  });

  test("exactly one pane is split off nothing — the initial surface is consumed once", () => {
    // Two nulls would leave a split unissued and a pane unbuilt; zero would
    // leave the workspace's own surface as a stray idle shell beside three
    // others.
    expect(plan().filter((p) => p.split === null).length).toBe(1);
    expect(paneNamed("observer").split).toBeNull();
  });

  test("every command is something cmux will accept as --command text", () => {
    // `assertCmuxText` is imported, not re-implemented: a local copy of the
    // rule would drift from the one that actually runs at the call site.
    for (const p of plan()) {
      expect(() => assertCmuxText(`pane ${p.title}`, p.command)).not.toThrow();
    }
  });
});

describe("the observer pane", () => {
  test("each agent pane runs its OWN `up`, naming only its own worker", () => {
    // Two attended panes are two runs. `--attach-here` hands over the terminal
    // of the process that runs it, and one process has one terminal:
    // attended/adopt.ts refuses with "can hand over ONE terminal and this run
    // has N tui workers". A single `up` naming both cannot attach both.
    expect(DEFAULT_OPERATIONS_WORKERS).toEqual(["obs-1", "tick-1"]);
    expect(paneNamed("observer").command).toContain("'up' '--workers' 'obs-1'");
    expect(paneNamed("ticketing").command).toContain("'up' '--workers' 'tick-1'");
    // And NEITHER names both — a combined set is the shape that cannot attach.
    for (const t of ["observer", "ticketing"]) {
      expect(paneNamed(t).command).not.toContain("'obs-1,tick-1'");
    }
  });

  /**
   * Pane 1 is the pane a human watches, and it must carry Pi's own interface
   * rather than a rendered tail. `attachHere` is what selects that.
   *
   * The false half is asserted alongside it deliberately: the two commands
   * differ by one flag, so a plan that ignored the option entirely would still
   * satisfy an assertion that only looked at the tui case.
   */
  /**
   * Attachment is per pane, resolved from each worker's own `pane_mode`.
   *
   * This replaced a wait-then-tail arrangement in which only one pane ran `up`
   * and the other waited for that run. Two defects lived there and are worth
   * keeping named: a run directory outlives its run, so `status` reports a
   * torn-down run's workers as `"alive":false,"phase":"dead"` and a wait that
   * only checked the worker was MENTIONED passed instantly against a corpse;
   * and `logs` then tailed a finished log file that never grew, so the pane
   * read as a hung worker while the pane beside it was healthy. Giving each
   * pane its own `up` removes the wait, and with it both failures.
   */
  test("only the workers that resolve to tui get --attach-here", () => {
    expect(paneNamed("observer", { tuiWorkers: ["obs-1"] }).command).toContain("'--attach-here'");
    expect(paneNamed("ticketing", { tuiWorkers: ["obs-1"] }).command).not.toContain(
      "'--attach-here'",
    );
    expect(paneNamed("ticketing", { tuiWorkers: ["obs-1", "tick-1"] }).command).toContain(
      "'--attach-here'",
    );
    // The empty set is asserted too: a plan ignoring the option entirely would
    // satisfy an assertion that only ever looked at the attached case.
    expect(paneNamed("observer", { tuiWorkers: [] }).command).not.toContain("'--attach-here'");
  });

  test("attachHere puts Pi's own interface in pane 1, and its absence does not", () => {
    expect(paneNamed("observer", { tuiWorkers: DEFAULT_OPERATIONS_WORKERS }).command).toContain("'--attach-here'");
    expect(paneNamed("observer", { tuiWorkers: [] }).command).not.toContain("'--attach-here'");
  });

  /**
   * `scripts/operations` decides pane 1's MODE by resolving one worker's
   * pane_mode, while `operationsPanes` builds pane 1's COMMAND from this list.
   * They must name the same worker or the console asks for one and renders the
   * other -- which is exactly what happened: the script carried its own literal
   * "tick-1" fallback after the plan had moved to obs-1, so the pane brought up
   * obs-1 and then tailed its log, because tick-1 resolves to rpc.
   *
   * The script now reads DEFAULT_OPERATIONS_WORKERS. This pins the property the
   * fix relies on, so a future edit cannot silently desynchronise the two again.
   */
  test("the observer pane shows the HEAD of DEFAULT_OPERATIONS_WORKERS, and no second literal", () => {
    const head = DEFAULT_OPERATIONS_WORKERS[0]!;
    expect(paneNamed("observer").command).toContain(`'logs' '--worker' '${head}'`);
    expect(paneNamed("observer").command).toContain(`'shell' '--worker' '${head}'`);
    // And the ticketing pane shows the SECOND, never the head — the two panes
    // reading the same worker is the shape this layout exists to avoid.
    const second = DEFAULT_OPERATIONS_WORKERS[1]!;
    expect(paneNamed("ticketing").command).toContain(`'logs' '--worker' '${second}'`);
    expect(paneNamed("ticketing").command).not.toContain(`'logs' '--worker' '${head}'`);
  });

  test("names the CLI by absolute path under the repo, because pifleet is not on PATH", () => {
    // Measured 2026-08-30: `which pifleet` finds nothing — the package is
    // `private: true` and its bin entry is never linked. A pane invoking a bare
    // `pifleet` would work only on a machine where somebody had linked it.
    const cmd = paneNamed("observer").command;
    expect(cmd).toContain("bun run ");
    expect(cmd).toContain(`'${REPO}/src/cli/index.ts'`);
  });

  test("loads ~/.env into the pane BEFORE up runs, and exports it", () => {
    // Measured on the first live run: `OMLX_API_KEY` is in `~/.env`, no shell
    // profile sources that file, and `up` warned the worker "will only reach a
    // server that needs none" — which against an endpoint that does need one
    // is every request refused.
    const cmd = paneNamed("observer").command;
    expect(cmd).toContain(`[ -f "$HOME/.env" ]`);
    // `set -a` is the load-bearing half: `up` is a CHILD, and a sourced
    // variable that is not exported is invisible to it. Sourcing without it
    // reproduces the same failure while looking fixed.
    expect(cmd).toContain("set -a;");
    expect(cmd.indexOf("$HOME/.env")).toBeLessThan(cmd.indexOf("'up'"));
  });

  test("drops to an interactive shell, and does so even when up fails", () => {
    const cmd = paneNamed("observer").command;
    // The pane must survive `up` returning — a pane whose command exits is a
    // pane cmux tears down, and this one is the dispatch console.
    expect(cmd).toContain("exec $SHELL -i");
    // `;` and NOT `&&`. Proved by mutation: with `&&` a refused admission
    // closes the pane and the operator never reads why.
    expect(cmd).toContain("; exec $SHELL -i");
    expect(cmd).not.toContain("&& exec");
  });

  test("takes a collection of workers, not just one", () => {
    // `up --workers` is a SET (ISC-61); the console has no business being
    // narrower than the command it drives.
    // The set spreads ACROSS panes now, one worker each, rather than into one
    // `--workers` list — that is what makes each pane separately attachable.
    expect(paneNamed("observer", { workers: ["tick-1", "sre-1"] }).command).toContain(
      "'--workers' 'tick-1'",
    );
    expect(paneNamed("ticketing", { workers: ["tick-1", "sre-1"] }).command).toContain(
      "'--workers' 'sre-1'",
    );
  });

  test("runs headless, so the fleet does not open panes of its own", () => {
    // A cmux-backed `up` inside a cmux pane would build a second workspace
    // beside this one — the console would appear to duplicate itself.
    expect(paneNamed("observer").command).toContain("'--backend' 'headless'");
  });

  test("defaults its config to the repo's fleet.yaml and accepts an override", () => {
    expect(paneNamed("observer").command).toContain(`'--config' '${REPO}/fleet.yaml'`);
    expect(paneNamed("observer", { configPath: "/tmp/other.yaml" }).command).toContain("'--config' '/tmp/other.yaml'");
  });

  test("refuses an empty worker set rather than launching the whole fleet", () => {
    // The dangerous failure is the silent one: an empty `--workers` that fell
    // through to "every worker in workers:" would bring up all seven.
    expect(() => plan({ workers: [] })).toThrow(/empty --workers/);
  });

  test("refuses a worker id that is not a plain identifier", () => {
    expect(() => plan({ workers: ["bad id"] })).toThrow(/not a plain identifier/);
    expect(() => plan({ workers: ["--backend"] })).toThrow(/not a plain identifier/);
  });
});

describe("the agent pane", () => {
  test("stages are up → viewer → container shell → host shell, in that order", () => {
    // The requirement, and it is an ORDER: the pane must never land on a host
    // prompt while anything above it is still available. A viewer placed after
    // the shell, or a host `$SHELL` reached before the container one, both
    // type-check and both give back the terminal the console exists to replace.
    const cmd = paneNamed("observer").command;
    const at = (needle: string) => cmd.indexOf(needle);
    expect(at("'up'")).toBeGreaterThan(-1);
    expect(at("'up'")).toBeLessThan(at("'logs'"));
    expect(at("'logs'")).toBeLessThan(at("'shell'"));
    expect(at("'shell'")).toBeLessThan(at("exec $SHELL"));
  });

  test("the viewer FOLLOWS and RENDERS — it blocks, and a human reads it", () => {
    // `--follow` is what makes the pane sit on an idle worker and come alive on
    // dispatch; without it `logs` prints the backlog and exits, and the pane
    // falls straight through to the shell. `--render` is the difference between
    // an operator reading events and an operator reading raw JSONL.
    const cmd = paneNamed("observer").command;
    expect(cmd).toContain("'logs'");
    expect(cmd).toContain("'--follow'");
    expect(cmd).toContain("'--render'");
  });

  test("viewer and shell both name the FIRST configured worker", () => {
    // A pane shows one worker. Hardcoding `tick-1` would silently show the
    // wrong agent for `--workers rev-1`, with the pane looking perfectly
    // healthy while tailing a worker nobody asked about.
    const cmd = paneNamed("observer", { workers: ["rev-1", "eng-1"] }).command;
    expect(cmd).toContain("'logs' '--worker' 'rev-1'");
    expect(cmd).toContain("'shell' '--worker' 'rev-1'");
    expect(cmd).not.toContain("'--worker' 'eng-1'");
  });

  test("the stages are joined by `;`, never `&&`", () => {
    // With `&&` a refused `up` closes the pane, taking its own error message
    // with it — measured on the first live run, where the shell was the only
    // thing that made the refusal readable. Each stage must be reachable
    // whether or not the one before it succeeded.
    //
    // Sliced from `'up'` onward, and the first version of this was NOT: a bare
    // `not.toContain("&&")` failed on `envPreamble`'s own
    // `[ -f "$HOME/.env" ] && . "$HOME/.env"`, which is a legitimate guard and
    // not a stage separator. An assertion that cannot tell the two apart would
    // have had to be deleted or weakened; scoping it to the stages keeps it.
    const cmd = paneNamed("observer").command;
    expect(cmd.slice(cmd.indexOf("'up'"))).not.toContain("&&");
  });
});

describe("the monitor pane — the eleven assertions that survived the merge", () => {
  /**
   * ## Why this block exists in this shape (ISC-493)
   *
   * `fleet-status` and `git-watch` were two panes with eleven assertions
   * between them, and the merge took away every one of their SUBJECTS at once.
   * Eleven tests went red simultaneously and none of them because anything was
   * wrong — which is exactly the moment a measured constraint gets deleted
   * because "the function it covered was renamed".
   *
   * So each is restated here against the pane that replaced them, and where a
   * requirement is now met by a DIFFERENT mechanism the restatement says which
   * one. Two could not be restated as written and both say why in place, rather
   * than disappearing.
   */
  const monitorCmd = () => paneNamed("monitor").command;

  // ---- from `the fleet-status pane` -------------------------------------

  test("refreshes forever, so the pane cannot print once and close", () => {
    /*
     * The original requirement, unchanged; the mechanism is different for the
     * third time. `pifleet status` printed once and exited, so it was wrapped
     * in a shell loop; the monitor is a process that does not return until
     * interrupted, so there is no loop to assert on. What CAN be asserted is
     * that the pane does not run the one-shot form — `--once` prints a frame
     * and exits, which is the original defect exactly.
     */
    expect(monitorCmd()).toContain("'monitor'");
    expect(monitorCmd()).not.toContain("--once");
  });

  test("CLEARS before each refresh rather than appending", () => {
    /*
     * RESTATED, NOT RETIRED, and this is one of the two ISC-493 flagged.
     *
     * The original asserted `clear;` in the pane's shell text and `not
     * --watch`. Neither is assertable now: the clearing moved inside the
     * monitor process, which writes cursor-home-and-erase itself. The measured
     * lesson is what matters — `status --watch` APPENDS, and the live console
     * showed what that costs: dozens of identical `dead supervisor=gone` blocks
     * scrolled past each other, so the pane was a transcript of how long a dead
     * worker had been dead rather than a display of the fleet.
     *
     * Two assertions replace it: the pane must not reach for the appending form
     * at all, and the monitor's own paint path must issue the erase. The second
     * is a source assertion because there is no shell text left to read.
     */
    expect(monitorCmd()).not.toContain("--watch");
    expect(monitorCmd()).not.toContain("status");
    const source = readFileSync(
      new URL("../../src/cli/commands/monitor.ts", import.meta.url).pathname,
      "utf8",
    );
    // ESC[H (home) ESC[2J (erase) — written before every frame that changed.
    expect(source).toContain("\\x1b[H\\x1b[2J");
  });

  test("survives a command that exits non-zero", () => {
    /*
     * `|| true` existed because the loop died on the first refresh after a
     * `down` — exactly when an operator looks at it. There is no loop now, so
     * the guarantee moved to the rung after it: `;` before `exec $SHELL -i`,
     * never `&&`. The monitor exiting for ANY reason leaves a usable shell
     * instead of closing the pane and taking the diagnosis with it.
     */
    expect(monitorCmd()).toContain("; exec $SHELL -i");
    expect(monitorCmd()).not.toContain("&& exec");
  });

  test("takes its refresh interval from the same one flag both panes shared", () => {
    /*
     * ISC-490: `--poll` KEEPS ITS NAME AND CHANGES ITS MEANING, decided rather
     * than left dangling. It used to be the read interval for two shell loops.
     * It is now the REPAINT interval of one process whose reads are on three
     * clocks of their own — so the operator-visible behaviour it governs, how
     * quickly the pane reflects a change, is the same, which is why it keeps
     * the name instead of being retired.
     *
     * The old assertion was that two panes polled in step. One pane cannot be
     * out of step with itself, so what survives is the flag's route from the
     * plan option to the command.
     */
    expect(paneNamed("monitor", { gitPollSeconds: 11 }).command).toContain("'--poll' '11'");
    expect(paneNamed("monitor", { gitPollSeconds: 30 }).command).toContain("'--poll' '30'");
  });

  // ---- from `the git-watch pane` ----------------------------------------

  /*
   * REMOVED 2026-09-04 with the monitor's git region: "reports on the
   * INVOCATION directory, never on cmux-fleet", and the two tests that pinned
   * git's argv through `statusArgv`/`logArgv`.
   *
   * All three were about `--repo`, which existed for exactly one consumer —
   * `git -C <watchDir>` inside the strip that showed the invocation
   * directory's `git status` beside the fleet table. The operator removed the
   * region as answering a question nobody asked on that screen; the flag and
   * the reader went with it, so there is no longer a watched directory for
   * this console to get right or wrong.
   *
   * Deleted rather than adapted. Each one asserted a property of a feature
   * that no longer exists, and the mechanical rewrite — assert the flag is
   * ABSENT — would pin the absence of one flag among hundreds, which is not a
   * property worth a test. What DOES survive is the quoting test at the
   * bottom, rewritten onto the one value still injected into this command.
   */


  test("no watch(1), because macOS does not ship one", () => {
    /*
     * A HOST fact (`operations-plan.ts:47-50`), not a pane fact, which is
     * precisely why it must outlive the pane that recorded it. `watch` is
     * procps; macOS has none, so the obvious way to write a refreshing pane
     * fails on tick one with `command not found` and leaves a dead pane that
     * looks configured.
     *
     * The tripwire is deliberately BLUNT — any occurrence of the bare word.
     * That bluntness has already been paid for once: the monitor's flag was
     * originally `--watch-dir`, which matches, and it was renamed to `--repo`
     * rather than narrowing this regex on behalf of a flag name.
     */
    expect(monitorCmd()).not.toMatch(/\bwatch\b/);
  });


  test("takes a poll interval and refuses a nonsensical one", () => {
    // Unchanged and still validated in the plan, because a zero or fractional
    // interval is a busy loop on the operator's machine whichever process runs
    // it. The monitor clamps as well, but the plan refusing early is what gives
    // the operator a diagnosis instead of a spinning pane.
    expect(paneNamed("monitor", { gitPollSeconds: 30 }).command).toContain("'--poll' '30'");
    expect(() => plan({ gitPollSeconds: 0 })).toThrow(/positive whole number/);
    expect(() => plan({ gitPollSeconds: 1.5 })).toThrow(/positive whole number/);
    expect(() => plan({ gitPollSeconds: Number.NaN })).toThrow(/positive whole number/);
  });

  // ---- new, and only assertable because of the merge ---------------------

  test("is invoked through an absolute path, never a bare `pifleet`", () => {
    // ISC-488. `:43-46`'s host fact: the bin is never linked, so a bare
    // invocation fails with `command not found` in a pane that looks correctly
    // configured — the same failure shape as `watch(1)`, from a different
    // cause.
    expect(monitorCmd()).toContain(`bun run '${REPO}/src/cli/index.ts' 'monitor'`);
  });

  test("the two shell-loop builders it replaced are gone, not merely unused", () => {
    /*
     * `statusWatchCommand` and `gitWatchCommand` were exported so their panes'
     * criteria had something to assert against. After the merge nothing calls
     * them. Keeping them would be the dead-field shape `contracts.ts:86-118`
     * records, with the added cost that a reader could not tell which builder
     * the console actually runs — so the deletion is asserted rather than
     * assumed.
     */
    const source = readFileSync(
      new URL("../../src/backends/cmux/operations-plan.ts", import.meta.url).pathname,
      "utf8",
    );
    expect(source).not.toContain("export function statusWatchCommand");
    expect(source).not.toContain("export function gitWatchCommand");
    expect(source).not.toContain("function redrawOnChange");
  });
});

describe("quoting", () => {
  test("a directory containing a quote cannot break out of the command", () => {
    // `--command` text is shell-INJECTED, not exec'd (SRD §4.1), so an
    // unquoted path is command injection by construction.
    /*
     * The subject moved with `--repo`'s removal. `monitorPaneCommand` now
     * injects exactly one caller-supplied path — `repoRoot`, where the CLI
     * itself lives — so that is what this proves cannot break out. A test left
     * pointed at the deleted argument would have been rewritten into a
     * two-argument call that quoted nothing.
     */
    const nasty = `/tmp/it's here; touch /tmp/pwned`;
    const cmd = monitorPaneCommand(nasty, 5);
    // `repoRoot` reaches the command with `/src/cli/index.ts` appended, so the
    // quoted argument is the whole path — assert the ESCAPING, which is the
    // security property, rather than a literal prefix of it.
    expect(cmd).toContain(`'/tmp/it'"'"'s here; touch /tmp/pwned/src/cli/index.ts'`);
    // NOT asserted: that `; touch` is absent. It is present, and that is the
    // correct outcome — it sits INSIDE the single-quoted argument, which is
    // what "cannot break out" means. An absence assertion here would fail on
    // correct code and pass on a build that dropped the path entirely.
    /*
     * Belt AND braces after the merge, because there are now TWO boundaries and
     * only one of them is this quoting. The pane text is shell-injected, so the
     * quoting above is what stops the injection there; the monitor then spawns
     * git as ARGV with no shell at all (`read/git.ts`), so the same string
     * cannot be re-interpreted one layer down. The old pane had only the first.
     */
  });

  test("pifleetCommand quotes every argument it is given", () => {
    expect(pifleetCommand("/r", ["up", "--workers", "a b"])).toBe(
      `bun run '/r/src/cli/index.ts' 'up' '--workers' 'a b'`,
    );
  });
});

// ---------------------------------------------------------------------------
// The bottom row's share of the height
// ---------------------------------------------------------------------------

/**
 * The requirement is stated about the BOTTOM row and asserted about it here,
 * even though the constant it constrains is the top one.
 *
 * `applyTopFraction` resizes the panes sharing the minimum `y`, so the top
 * fraction is the number the code can act on and the one the module exports.
 * Asserting that number alone would pin an implementation detail and leave the
 * thing actually asked for — a bottom row of 35% — nowhere in the suite, so a
 * later edit that "simplified" the complement back to a half would pass.
 *
 * `toBeCloseTo` rather than `toBe`: the value is a decimal fraction and the
 * complement of one is not exactly representable, which is a property of
 * binary floating point and not of the layout. Two decimal places is three
 * orders of magnitude finer than a terminal row.
 */
describe("the operations console reserves 35% of the height for the bottom row", () => {
  test("the bottom row's share is 35%", () => {
    expect(1 - OPERATIONS_TOP_FRACTION).toBeCloseTo(0.35, 2);
  });

  /**
   * The direction, asserted separately, because "the bottom row is 35%" is
   * also satisfied by 0.35 written into the top constant by mistake — which
   * would put the SMALL row where the agents are and hand the status table and
   * the git log two thirds of the window.
   */
  test("the top row keeps the majority of the height", () => {
    expect(OPERATIONS_TOP_FRACTION).toBeGreaterThan(0.5);
  });
});
