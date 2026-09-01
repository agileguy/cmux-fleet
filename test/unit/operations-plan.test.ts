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

import { assertCmuxText } from "../../src/backends/cmux/client.ts";
import {
  DEFAULT_OPERATIONS_WORKERS,
  OPERATIONS_WORKSPACE,
  gitWatchCommand,
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
  test("is exactly four panes, in creation order", () => {
    // Order is contract: pane 1 consumes the workspace's initial surface and is
    // where the operator lands.
    expect(plan().map((p) => p.title)).toEqual([
      "observer",
      "ticketing",
      "fleet-status",
      "git-watch",
    ]);
  });

  test("the observer pane takes the whole top half; the other two tile beneath it", () => {
    // The requested shape:
    //
    //   +-------------------------------+
    //   |           observer            |
    //   +---------------+---------------+
    //   |  fleet-status |   git-watch   |
    //   +---------------+---------------+
    //
    // `null` then `down` then `right` is the ONLY sequence that produces it,
    // and each element is load-bearing. `down` first is what makes pane 1 a
    // half rather than a column — the first split decides the major axis. The
    // `right` that follows lands INSIDE the half `down` created, because each
    // pane is split off the previous one; a `right` off pane 1 instead would
    // put git-watch in the top row beside pane 1, which is the layout this
    // replaced and which no assertion on directions alone would catch.
    expect(plan().map((p) => p.split)).toEqual([null, "left", "down", "down"]);
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
  test("one `up` stands BOTH console workers up, and only one pane runs it", () => {
    // The observer leads because workers[0] is both the attach target and the
    // worker this pane shows. tick-1 rides along so the ticketing pane beside
    // it has something to tail.
    expect(DEFAULT_OPERATIONS_WORKERS).toEqual(["obs-1", "tick-1"]);
    expect(paneNamed("observer").command).toContain("'up' '--workers' 'obs-1,tick-1'");
    // Exactly one, and this is the assertion that matters: `up` creates a RUN,
    // so a second pane running it would give two runs and two sets of
    // containers for a console the operator thinks is one thing.
    expect(plan().filter((pane) => pane.command.includes("'up'")).length).toBe(1);
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
   * The ticketing pane waits for its worker to be ALIVE, and then pins the run.
   *
   * Both halves are load-bearing and both come from a live failure. A run's
   * directory outlives the run, so `status` keeps reporting a torn-down run's
   * workers as `"alive":false,"phase":"dead"` — a wait that only checked the
   * worker was MENTIONED passed instantly against a corpse, and `logs` then
   * tailed a finished log file that never grew. Twice, the pane sat showing
   * events minutes older than the run the console had just created while the
   * observer beside it was healthy.
   *
   * `--run "$r"` is the second half: without it `logs` re-resolves the most
   * recent run on every invocation and can drift onto a later one.
   */
  test("the ticketing pane waits for a LIVE worker and pins the run it found", () => {
    const cmd = paneNamed("ticketing").command;
    const second = DEFAULT_OPERATIONS_WORKERS[1]!;
    expect(cmd).toContain(`'"id":"${second}","alive":true'`);
    expect(cmd).toContain('--run "$r"');
    // Mentioning the worker is NOT the condition — that is the bug this
    // replaced, and a wait that greps the bare id passes against a dead run.
    expect(cmd).not.toContain(`grep -q '${second}'`);
  });

  test("attachHere puts Pi's own interface in pane 1, and its absence does not", () => {
    expect(paneNamed("observer", { attachHere: true }).command).toContain("'--attach-here'");
    expect(paneNamed("observer", { attachHere: false }).command).not.toContain("'--attach-here'");
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
    expect(paneNamed("observer", { workers: ["tick-1", "sre-1"] }).command).toContain(
      "'--workers' 'tick-1,sre-1'",
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

describe("the fleet-status pane", () => {
  test("refreshes forever, so the pane cannot print once and close", () => {
    // The original requirement, unchanged: `pifleet status` on its own prints
    // once and exits, which closes the pane — the same defect as pane 1's, in a
    // place with no shell after it. What changed is HOW it keeps running.
    const cmd = paneNamed("fleet-status").command;
    expect(cmd).toMatch(/^while :; do/);
    expect(cmd).toContain("'status'");
  });

  test("CLEARS before each refresh — a standing pane is read at a glance", () => {
    // `status --watch` APPENDS, and the live console measured what that costs:
    // dozens of identical `run 2026-08-24… / eng-1: dead supervisor=gone`
    // blocks scrolled past each other, so the pane was a transcript of how long
    // a dead worker had been dead rather than a display of the fleet. Only the
    // last screen is ever read; everything above it is cost with no reader.
    expect(paneNamed("fleet-status").command).toContain("clear;");
    // And specifically NOT the built-in watch, which is the form that appends.
    expect(paneNamed("fleet-status").command).not.toContain("--watch");
  });

  test("survives a status that exits non-zero", () => {
    // Without `|| true` the loop dies on the first refresh after a `down` —
    // exactly when an operator looks at it — leaving a pane that stopped
    // updating and does not say so.
    expect(paneNamed("fleet-status").command).toContain("|| true");
  });

  test("polls on the SAME interval as the git pane, from the same flag", () => {
    // One `--poll` governs both, so a `down` appears in the two panes at the
    // same moment rather than in whichever happens to poll first.
    expect(paneNamed("fleet-status", { gitPollSeconds: 11 }).command).toContain("sleep 11");
    expect(paneNamed("git-watch", { gitPollSeconds: 11 }).command).toContain("sleep 11");
  });
});

describe("the git-watch pane", () => {
  test("reports on the INVOCATION directory, never on cmux-fleet", () => {
    // The requirement, and the one most easily got wrong: this console is a
    // place to stand while working on some other repository. Proved by
    // mutation — passing `repoRoot` here reddens.
    const cmd = paneNamed("git-watch").command;
    expect(cmd).toContain(`-C '${CWD}'`);
    expect(cmd).not.toContain(REPO);
  });

  test("runs git with --no-pager, or the loop stops at (END) forever", () => {
    // MEASURED, not anticipated. On the first live run `git log` found a
    // terminal on stdout, started `less`, and the pane sat at `(END)` waiting
    // for a keypress. It showed a plausible commit list and refreshed never —
    // a hang that looks exactly like a working watch.
    const cmd = paneNamed("git-watch").command;
    const gitCalls = [...cmd.matchAll(/git\s+(\S+)/g)].map((m) => m[1]);
    expect(gitCalls.length, "no git invocations found — the probe has rotted").toBeGreaterThanOrEqual(2);
    // EVERY invocation, not just the log: `status` pages too once its output
    // is longer than the pane.
    for (const first of gitCalls) expect(first).toBe("--no-pager");
  });

  test("is a shell loop, because macOS has no watch(1)", () => {
    const cmd = paneNamed("git-watch").command;
    expect(cmd).toMatch(/^while :; do/);
    // procps' `watch` is the obvious way to write this and fails on tick one
    // here with `command not found`, leaving a dead pane that looks configured.
    expect(cmd).not.toMatch(/\bwatch\b/);
  });

  test("shows branch and recent history, and clears before printing", () => {
    const cmd = paneNamed("git-watch").command;
    expect(cmd).toContain("status --short --branch");
    expect(cmd).toContain("log --oneline -10");
    // Clearing after printing leaves the pane blank between ticks, which reads
    // as a hung console.
    expect(cmd.indexOf("clear")).toBeLessThan(cmd.indexOf("status --short"));
  });

  test("takes a poll interval and refuses a nonsensical one", () => {
    expect(plan({ gitPollSeconds: 30 })[2]!.command).toContain("sleep 30");
    // A zero or fractional interval is a busy loop on the operator's machine.
    expect(() => plan({ gitPollSeconds: 0 })).toThrow(/positive whole number/);
    expect(() => plan({ gitPollSeconds: 1.5 })).toThrow(/positive whole number/);
    expect(() => plan({ gitPollSeconds: Number.NaN })).toThrow(/positive whole number/);
  });
});

describe("quoting", () => {
  test("a directory containing a quote cannot break out of the command", () => {
    // `--command` text is shell-INJECTED, not exec'd (SRD §4.1), so an
    // unquoted path is command injection by construction.
    const nasty = `/tmp/it's here; touch /tmp/pwned`;
    const cmd = gitWatchCommand(nasty, 5);
    expect(cmd).toContain(`'/tmp/it'"'"'s here; touch /tmp/pwned'`);
  });

  test("pifleetCommand quotes every argument it is given", () => {
    expect(pifleetCommand("/r", ["up", "--workers", "a b"])).toBe(
      `bun run '/r/src/cli/index.ts' 'up' '--workers' 'a b'`,
    );
  });
});
