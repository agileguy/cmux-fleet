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

describe("the workspace identity", () => {
  test("is the literal name the idempotency check matches on", () => {
    // Both `scripts/operations` and `findOperations` read this constant, so it
    // cannot drift between the creator and the finder — but a rename would
    // orphan every console already open, so it is pinned.
    expect(OPERATIONS_WORKSPACE).toBe("operations");
  });
});

describe("the pane set", () => {
  test("is exactly three panes, in a fixed order", () => {
    // Order is contract: pane 1 consumes the workspace's initial surface and is
    // where the operator lands.
    expect(plan().map((p) => p.title)).toEqual(["ticketing", "fleet-status", "git-watch"]);
  });

  test("every command is something cmux will accept as --command text", () => {
    // `assertCmuxText` is imported, not re-implemented: a local copy of the
    // rule would drift from the one that actually runs at the call site.
    for (const p of plan()) {
      expect(() => assertCmuxText(`pane ${p.title}`, p.command)).not.toThrow();
    }
  });
});

describe("pane 1 — the ticketing agent", () => {
  test("brings up the ticketing worker and nothing else by default", () => {
    expect(DEFAULT_OPERATIONS_WORKERS).toEqual(["tick-1"]);
    expect(plan()[0]!.command).toContain("'up' '--workers' 'tick-1'");
  });

  test("names the CLI by absolute path under the repo, because pifleet is not on PATH", () => {
    // Measured 2026-08-30: `which pifleet` finds nothing — the package is
    // `private: true` and its bin entry is never linked. A pane invoking a bare
    // `pifleet` would work only on a machine where somebody had linked it.
    const cmd = plan()[0]!.command;
    expect(cmd.startsWith("bun run ")).toBe(true);
    expect(cmd).toContain(`'${REPO}/src/cli/index.ts'`);
  });

  test("drops to an interactive shell, and does so even when up fails", () => {
    const cmd = plan()[0]!.command;
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
    expect(plan({ workers: ["tick-1", "sre-1"] })[0]!.command).toContain(
      "'--workers' 'tick-1,sre-1'",
    );
  });

  test("runs headless, so the fleet does not open panes of its own", () => {
    // A cmux-backed `up` inside a cmux pane would build a second workspace
    // beside this one — the console would appear to duplicate itself.
    expect(plan()[0]!.command).toContain("'--backend' 'headless'");
  });

  test("defaults its config to the repo's fleet.yaml and accepts an override", () => {
    expect(plan()[0]!.command).toContain(`'--config' '${REPO}/fleet.yaml'`);
    expect(plan({ configPath: "/tmp/other.yaml" })[0]!.command).toContain("'--config' '/tmp/other.yaml'");
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

describe("pane 2 — fleet status", () => {
  test("is the watching form, not a one-shot snapshot", () => {
    // `pifleet status` without `--watch` prints once and exits, which closes
    // the pane — the same defect as pane 1's, in a place with no shell after it.
    expect(plan()[1]!.command).toContain("'status' '--watch'");
  });
});

describe("pane 3 — the git watch", () => {
  test("reports on the INVOCATION directory, never on cmux-fleet", () => {
    // The requirement, and the one most easily got wrong: this console is a
    // place to stand while working on some other repository. Proved by
    // mutation — passing `repoRoot` here reddens.
    const cmd = plan()[2]!.command;
    expect(cmd).toContain(`git -C '${CWD}'`);
    expect(cmd).not.toContain(REPO);
  });

  test("is a shell loop, because macOS has no watch(1)", () => {
    const cmd = plan()[2]!.command;
    expect(cmd).toMatch(/^while :; do/);
    // procps' `watch` is the obvious way to write this and fails on tick one
    // here with `command not found`, leaving a dead pane that looks configured.
    expect(cmd).not.toMatch(/\bwatch\b/);
  });

  test("shows branch and recent history, and clears before printing", () => {
    const cmd = plan()[2]!.command;
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
