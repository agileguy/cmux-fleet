/**
 * THE CONSOLE TELLS `up` WHAT ITS WORKSPACE IS CALLED — the whole chain, as
 * behaviour rather than as source reading.
 *
 * ## Why this file exists, stated as the gap it closes
 *
 * The monitor groups workers by workspace and heads each group with the
 * workspace's NAME, falling back to its UUID ref. `up` cannot discover that
 * name: it runs inside a pane whose environment carries `CMUX_WORKSPACE_ID`
 * and no title (probed against the installed cmux 0.64.x — the binary exports
 * `CMUX_WORKSPACE_ID`, `CMUX_SURFACE_ID` and `CMUX_PANE_ID` and nothing of the
 * sort), and it must not ask cmux, because ISC-137 confines cmux imports to
 * `src/backends/cmux/` and `up --attach-here` needs no cmux socket today.
 *
 * The console knows, because the console is what asked cmux to create or match
 * that title. So the name travels: `WorkspaceSpec.name` -> `planPanes` ->
 * `agentPaneCommand` -> the `up` argv -> `respawn-pane --command`.
 *
 * **For three rounds that chain was carried as a NAMED GAP, proved only by
 * reading the source**, because the only file that could have proved it was
 * `up.ts` and `up` cannot be invoked from a unit test. `agentPaneCommand` is a
 * pure function returning a string and `ensureWorkspace` is drivable through a
 * scripted `Exec`, so the console half is observable. This file observes it.
 *
 * ## THE DEGENERATE-FIXTURE TRAP, and how each assertion avoids it
 *
 * A fixture whose workspace name happens to equal something a naive
 * implementation would also produce — the console's label, the worker id, the
 * backend, a path fragment — passes while proving nothing: the argv could be
 * following any of them. So the explicit-name assertions use
 * {@link ASYMMETRIC}, a string equal to nothing else in scope, and the
 * spec-injection assertions separately pin that the REAL consoles emit their
 * OWN names. Neither set alone is enough; a design that ignored the option and
 * hardcoded `"operations"` would pass the second and fail the first.
 */
import { describe, expect, test } from "bun:test";
import { Command } from "commander";

import { CmuxClient } from "../../src/backends/cmux/client.ts";
import type { ExecResult } from "../../src/container/run.ts";
import {
  DEFAULT_DEVELOPMENT_WORKERS,
  DEFAULT_OPERATIONS_WORKERS,
  DEFAULT_REVIEW_WORKERS,
  agentPaneCommand,
  developmentPanes,
  operationsPanes,
  reviewPanes,
} from "../../src/backends/cmux/operations-plan.ts";
import {
  ensureDevelopment,
  ensureOperations,
  ensureReview,
} from "../../src/backends/cmux/operations.ts";
import { presentedWorkspace, register } from "../../src/cli/commands/up.ts";

const REPO = "/Users/x/repos/cmux-fleet";
const CWD = "/Users/x/repos/somewhere-else";

/**
 * A workspace name equal to NOTHING ELSE the plan has in scope.
 *
 * Not `operations`/`development`/`review` (the console labels and the real
 * spec names), not a worker id, not `headless`, not a fragment of `REPO` or
 * `CWD`, not `fleet.yaml`. If the argv carries this string, it followed the
 * `workspaceName` option and nothing else could have supplied it.
 */
const ASYMMETRIC = "ws-asym-9f3c";

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const verb = (argv: string[]): string =>
  argv[1] === "workspace" ? `workspace ${argv[2]}` : String(argv[1]);

/**
 * A scripted cmux, on `operations-workspace.test.ts`'s pattern — no cmux, no
 * GUI, no containers. Every argv is recorded so the `respawn-pane --command`
 * strings can be read back.
 */
function fakeCmux(): { client: CmuxClient; calls: string[][] } {
  const calls: string[][] = [];
  let splits = 0;
  const client = new CmuxClient({
    exec: async (argv) => {
      calls.push(argv.slice(1));
      switch (verb(argv)) {
        case "ping":
          return ok("");
        case "workspace list":
          return ok(JSON.stringify({ window_id: "win-1", workspaces: [] }));
        case "workspace create":
          return ok(JSON.stringify({ workspace_id: "ws-new", surface_id: "surf-0", window_id: "win-1" }));
        case "new-split": {
          splits += 1;
          return ok(JSON.stringify({ pane_id: `pane-${splits}`, surface_id: `surf-${splits}` }));
        }
        case "list-panes":
          return ok(
            JSON.stringify({
              panes: [
                { id: "pane-1", selected_surface_id: "surf-1", index: 1 },
                { id: "pane-2", selected_surface_id: "surf-2", index: 2 },
                { id: "pane-3", selected_surface_id: "surf-3", index: 3 },
                { id: "pane-0", selected_surface_id: "surf-0", index: 0 },
              ],
            }),
          );
        default:
          return ok("");
      }
    },
  });
  return { client, calls };
}

/** Every `--command` string cmux was told to respawn a pane with. */
const respawnCommands = (calls: string[][]): string[] =>
  calls
    .filter((c) => c[0] === "respawn-pane")
    .map((c) => {
      const i = c.indexOf("--command");
      return i === -1 ? "" : (c[i + 1] ?? "");
    });

// ---------------------------------------------------------------------------
// The argv, with an asymmetric name — proves it followed the OPTION
// ---------------------------------------------------------------------------

describe("agentPaneCommand carries the workspace name into up's argv", () => {
  const cmd = (over: Partial<Parameters<typeof agentPaneCommand>[0]> = {}) =>
    agentPaneCommand({
      repoRoot: REPO,
      worker: "eng-1",
      backend: "headless",
      configPath: `${REPO}/fleet.yaml`,
      attach: true,
      ...over,
    });

  /**
   * THE ASSERTION THE WHOLE ROUND IS FOR. Shell-quoted, as every other flag in
   * this plan is asserted — `pifleetCommand` quotes the argv, so the quotes are
   * part of the observable.
   */
  test("an attached pane gets --workspace-name with the name it was given", () => {
    expect(cmd({ workspaceName: ASYMMETRIC })).toContain(`'--workspace-name' '${ASYMMETRIC}'`);
  });

  /**
   * THE NON-ATTACH ARM, which is a real branch and not a formality.
   *
   * A non-attached pane's `up` creates or forgoes its own workspace and names
   * it itself; `presentedWorkspace` treats pifleet's own name as authoritative
   * there and discards the flag outright. Emitting it anyway would put a flag
   * in the argv that the receiver is documented to ignore — which reads, to
   * anyone debugging a pane, as the console asking for something it is not
   * getting.
   */
  test("a NON-attached pane gets no --workspace-name at all", () => {
    const c = cmd({ workspaceName: ASYMMETRIC, attach: false });
    expect(c).not.toContain("--workspace-name");
    expect(c).not.toContain(ASYMMETRIC);
    // The control: this pane really is the non-attached one.
    expect(c).not.toContain("--attach-here");
  });

  /**
   * TESTING THE TESTER. The two assertions above are only a contrast if the
   * attached arm genuinely differs — a `cmd()` that ignored `attach` would
   * satisfy one of them by accident.
   */
  test("attach is what makes the difference, not the name", () => {
    expect(cmd({ workspaceName: ASYMMETRIC, attach: true })).toContain("--workspace-name");
    expect(cmd({ workspaceName: ASYMMETRIC, attach: false })).not.toContain("--workspace-name");
  });

  test("no name means no flag, attached or not", () => {
    for (const attach of [true, false]) {
      expect(cmd({ attach })).not.toContain("--workspace-name");
      expect(cmd({ workspaceName: "", attach })).not.toContain("--workspace-name");
    }
  });

  /**
   * The flag rides BESIDE `--attach-here`, not instead of it. A mutation that
   * swapped one for the other would satisfy every assertion above.
   */
  test("--attach-here is still emitted alongside it", () => {
    const c = cmd({ workspaceName: ASYMMETRIC });
    expect(c).toContain("'--attach-here'");
    expect(c).toContain("'--attach-clear'");
  });
});

// ---------------------------------------------------------------------------
// The three plans forward it
// ---------------------------------------------------------------------------

describe("every console's plan forwards the name to its attended panes", () => {
  const cases = [
    ["operations", operationsPanes, DEFAULT_OPERATIONS_WORKERS] as const,
    ["development", developmentPanes, DEFAULT_DEVELOPMENT_WORKERS] as const,
    ["review", reviewPanes, DEFAULT_REVIEW_WORKERS] as const,
  ];

  test("each plan's attended panes carry the asymmetric name", () => {
    for (const [label, panes, workers] of cases) {
      const built = panes({
        repoRoot: REPO,
        watchDir: CWD,
        tuiWorkers: [...workers],
        workspaceName: ASYMMETRIC,
      });
      const attended = built.filter((p) => p.command.includes("--attach-here"));
      expect({ label, attended: attended.length > 0 }).toEqual({ label, attended: true });
      for (const p of attended) {
        expect(p.command, `${label}/${p.title} lost the name`).toContain(
          `'--workspace-name' '${ASYMMETRIC}'`,
        );
      }
    }
  });

  /**
   * And the panes that are NOT agents — the git watch, the fleet status, the
   * monitor — must not acquire it. They run no `up`.
   */
  test("panes that run no up carry no --workspace-name", () => {
    const built = operationsPanes({
      repoRoot: REPO,
      watchDir: CWD,
      tuiWorkers: [],
      workspaceName: ASYMMETRIC,
    });
    for (const p of built) {
      expect(p.command, `${p.title} should not name a workspace`).not.toContain("--workspace-name");
    }
  });
});

// ---------------------------------------------------------------------------
// The REAL consoles inject their OWN names — end to end through cmux's argv
// ---------------------------------------------------------------------------

describe("the real consoles tell cmux to run an up that names their workspace", () => {
  /**
   * THE HOP THAT WAS PREVIOUSLY UNPROVED: `WorkspaceSpec.name` reaching the
   * command cmux is actually told to run.
   *
   * Driven through the scripted `Exec`, so what is asserted is the argv that
   * would have gone to the real binary — not a source string, and not a plan
   * this test built itself. `ensureWorkspace` folds `spec.name` in at
   * `planPanes`, and `spec.name` is the same field `workspace create --name`
   * uses, so the title the panes advertise cannot drift from the title the
   * workspace has.
   */
  const consoles = [
    ["operations", ensureOperations, DEFAULT_OPERATIONS_WORKERS] as const,
    ["development", ensureDevelopment, DEFAULT_DEVELOPMENT_WORKERS] as const,
    ["review", ensureReview, DEFAULT_REVIEW_WORKERS] as const,
  ];

  for (const [name, ensure, workers] of consoles) {
    test(`${name} respawns at least one pane whose up names '${name}'`, async () => {
      const { client, calls } = fakeCmux();
      await ensure(client, { repoRoot: REPO, watchDir: CWD, tuiWorkers: [...workers] });

      const commands = respawnCommands(calls);
      expect(commands.length).toBeGreaterThan(0);

      const naming = commands.filter((c) => c.includes(`'--workspace-name' '${name}'`));
      expect(naming.length, `no pane's up named the ${name} workspace`).toBeGreaterThan(0);

      // Every pane that attaches names it — not merely one of them.
      const attached = commands.filter((c) => c.includes("--attach-here"));
      expect(attached.length).toBe(naming.length);
    });
  }

  /**
   * THE ANTI-DEGENERACY CONTROL for the block above, and it is the assertion
   * that makes those three mean something.
   *
   * Each console must name ITS OWN workspace and not another's. Three tests
   * that each looked only for their own string would all pass against an
   * implementation that hardcoded one name, or that took the name from the
   * console `label` rather than from `spec.name` — the two are equal today, so
   * only a cross-check can tell them apart.
   */
  test("no console names a workspace belonging to another", async () => {
    const others: Record<string, string[]> = {
      operations: ["development", "review"],
      development: ["operations", "review"],
      review: ["operations", "development"],
    };
    for (const [name, ensure, workers] of consoles) {
      const { client, calls } = fakeCmux();
      await ensure(client, { repoRoot: REPO, watchDir: CWD, tuiWorkers: [...workers] });
      const joined = respawnCommands(calls).join("\n");
      for (const foreign of others[name]!) {
        expect(joined, `${name} named the ${foreign} workspace`).not.toContain(
          `'--workspace-name' '${foreign}'`,
        );
      }
    }
  });

  /**
   * And the workspace cmux is asked to CREATE carries the same title the panes
   * advertise. If these two ever disagree, the monitor would head a group with
   * a name no cmux workspace has.
   */
  test("the created workspace's --name is the name the panes advertise", async () => {
    for (const [name, ensure, workers] of consoles) {
      const { client, calls } = fakeCmux();
      await ensure(client, { repoRoot: REPO, watchDir: CWD, tuiWorkers: [...workers] });
      const create = calls.find((c) => c[0] === "workspace" && c[1] === "create");
      expect(create, `${name} created no workspace`).toBeDefined();
      const i = create!.indexOf("--name");
      expect(create![i + 1]).toBe(name);
      expect(respawnCommands(calls).join("\n")).toContain(`'--workspace-name' '${name}'`);
    }
  });

  /**
   * A console with NO tui workers attaches nothing, so it names nothing. The
   * non-attach arm again, this time through the real chain rather than through
   * `agentPaneCommand` alone.
   */
  test("a console whose workers are all rpc emits no --workspace-name", async () => {
    const { client, calls } = fakeCmux();
    await ensureOperations(client, { repoRoot: REPO, watchDir: CWD, tuiWorkers: [] });
    expect(respawnCommands(calls).join("\n")).not.toContain("--workspace-name");
  });
});

// ---------------------------------------------------------------------------
// The receiving end: the flag maps to the property `up` reads
// ---------------------------------------------------------------------------

describe("up's flag maps to the option presentedWorkspace is given", () => {
  /**
   * COMMANDER'S OWN NAMING, not a source grep.
   *
   * The console emits `--workspace-name`; `up`'s action reads
   * `opts.workspaceName`. Between them sits commander's flag-to-property
   * derivation, which is what would break if someone wrote `--workspace_name`
   * or `--ws-name` — a rename that leaves both halves internally consistent and
   * the wire silently dead. `attributeName()` is commander's own answer to
   * "which property does this flag set", so this asks the mechanism rather than
   * assuming it.
   */
  test("--workspace-name is registered and sets `workspaceName`", () => {
    const program = new Command();
    register(program);
    const up = program.commands.find((c) => c.name() === "up");
    expect(up, "up is not registered").toBeDefined();

    const opt = up!.options.find((o) => o.long === "--workspace-name");
    expect(opt, "--workspace-name is not a registered option").toBeDefined();
    expect(opt!.attributeName()).toBe("workspaceName");
    // It takes a value rather than being a boolean switch.
    expect(opt!.required || opt!.optional).toBe(true);
  });

  /**
   * And the value that arrives is recorded, for an adopted worker with a ref.
   * The helper's own suite sweeps this; it is repeated here so the chain reads
   * end to end in one file rather than stopping one hop short.
   */
  test("the value a console would send is what lands in the record", () => {
    expect(
      presentedWorkspace({ workspace: "WS-UUID" }, { id: null }, "pifleet-run", "review"),
    ).toEqual({ ref: "WS-UUID", name: "review" });
  });
});
