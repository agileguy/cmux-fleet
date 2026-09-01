/**
 * Building the `operations` workspace — and, first, refusing to build a second.
 *
 * Driven through a scripted `Exec`, so the ORDER and the TARGETS of the cmux
 * calls are re-checked on every run with no cmux, no GUI and no containers.
 * Order is the part that breaks: panes are created by splitting off the
 * previous surface, so a `respawn-pane` aimed at a stale id lands a command in
 * the wrong pane and looks, on screen, exactly like a pane that did not start.
 *
 * The idempotency assertions are the reason this file exists. This console
 * holds a live observer container and a shell an operator may have typed into;
 * from the outside, "refresh it" and "destroy it" are the same call. Proved by
 * mutation: making `ensureOperations` fall through to `createOperations` when a
 * workspace already exists reddens the first two tests below.
 */
import { describe, expect, test } from "bun:test";

import { CmuxClient } from "../../src/backends/cmux/client.ts";
import type { ExecResult } from "../../src/container/run.ts";
import { DEFAULT_OPERATIONS_WORKERS } from "../../src/backends/cmux/operations-plan.ts";
import { cmuxReachable, ensureOperations, selectWorkspaceArgv } from "../../src/backends/cmux/operations.ts";

const REPO = "/Users/x/repos/cmux-fleet";
const CWD = "/Users/x/repos/somewhere-else";
const OPTS = { repoRoot: REPO, watchDir: CWD };

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });

/** cmux's verb is argv[1] — argv[0] is the binary the client prepends. */
const verb = (argv: string[]): string =>
  argv[1] === "workspace" ? `workspace ${argv[2]}` : String(argv[1]);

interface Fake {
  client: CmuxClient;
  calls: string[][];
}

function fakeCmux(opts: { workspaces?: Array<{ id: string; custom_title: string | null }> } = {}): Fake {
  const calls: string[][] = [];
  let splits = 0;
  const client = new CmuxClient({
    exec: async (argv) => {
      calls.push(argv.slice(1));
      switch (verb(argv)) {
        case "ping":
          return ok("");
        case "workspace list":
          return ok(JSON.stringify({ window_id: "win-1", workspaces: opts.workspaces ?? [] }));
        case "workspace create":
          return ok(JSON.stringify({ workspace_id: "ws-new", surface_id: "surf-0", window_id: "win-1" }));
        case "new-split": {
          splits += 1;
          return ok(JSON.stringify({ pane_id: `pane-${splits}`, surface_id: `surf-${splits}` }));
        }
        case "list-panes":
          // pane-0 holds the workspace's initial surface — the one pane 1
          // consumes. Listed LAST so a probe that reads `panes[0]` instead of
          // matching on the surface id gets the wrong answer.
          return ok(
            JSON.stringify({
              panes: [
                { id: "pane-1", selected_surface_id: "surf-1", index: 1 },
                { id: "pane-2", selected_surface_id: "surf-2", index: 2 },
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

const verbsOf = (calls: string[][]): string[] => calls.map((c) => verb(["cmux", ...c]));

describe("an operations workspace that already exists is left alone", () => {
  test("it is selected, and nothing is created, split or respawned", async () => {
    const { client, calls } = fakeCmux({
      workspaces: [
        { id: "ws-other", custom_title: "pifleet" },
        { id: "ws-ops", custom_title: "operations" },
      ],
    });

    const result = await ensureOperations(client, OPTS);

    expect(result).toEqual({ created: false, workspaceId: "ws-ops" });
    // The destructive verbs must not appear AT ALL. Asserting on the whole
    // verb list rather than on a count: a rebuild that happened to issue the
    // same number of calls would pass a count check.
    expect(verbsOf(calls)).toEqual(["workspace list", "select-workspace"]);
    expect(calls[1]).toEqual(selectWorkspaceArgv("ws-ops"));
  });

  test("…unless --recreate, which BUILDS first and closes the old one second", async () => {
    // The gap adoption cannot reach, measured on the live console 2026-08-30:
    // `findOperations` matches a workspace TITLE, and a pane's contents are not
    // part of that. A console whose observer pane held a dead `up` from before
    // `envPreamble` existed, and whose status pane was watching a run six days
    // old, was adopted by every later `operations` and reported "already in
    // place — changed nothing". True, and useless.
    const { client, calls } = fakeCmux({
      workspaces: [{ id: "ws-ops", custom_title: "operations" }],
    });

    const result = await ensureOperations(client, OPTS, true);

    expect(result.created).toBe(true);
    const verbs = verbsOf(calls);
    expect(verbs).toContain("workspace close");
    /*
     * CREATE BEFORE CLOSE, and this assertion was written the OTHER WAY ROUND
     * first — mutation-proved in that direction, and pinning the wrong
     * requirement the whole time.
     *
     * MEASURED on the operator's console the first time `--recreate` ran:
     * `operations` was the ONLY workspace, closing it left the cmux app with no
     * window, and the create that followed failed with `unavailable: TabManager
     * not available`. So did every later call, `workspace list` included. The
     * flag whose job is to repair a stale console destroyed a working one and
     * left nothing able to rebuild it.
     *
     * The case for closing first was that two workspaces briefly share this
     * title. They do — for a few hundred milliseconds inside one function, with
     * nothing re-querying by title in between, and the close targeting a
     * CAPTURED id rather than a resolved name. A transient ambiguity nothing
     * observes against a console that cannot be rebuilt is not a close call.
     */
    expect(verbs.indexOf("workspace create")).toBeLessThan(verbs.indexOf("workspace close"));
    // By the OLD id. Closing a name here would close the console just built.
    expect(calls[verbs.indexOf("workspace close")]).toEqual(["workspace", "close", "ws-ops"]);
  });

  test("--recreate on a machine with NO operations workspace just builds one", async () => {
    // The flag must not require something to destroy. Without this, the close
    // could be made unconditional and every test above would still pass.
    const { client, calls } = fakeCmux({ workspaces: [{ id: "ws-other", custom_title: "pifleet" }] });
    const result = await ensureOperations(client, OPTS, true);
    expect(result.created).toBe(true);
    expect(verbsOf(calls)).not.toContain("workspace close");
  });

  test("matching is exact — a similarly named workspace is not adopted", async () => {
    // `operations-old` and `my-operations` are the workspaces a person
    // actually ends up with. Adopting either would split this console's panes
    // into somebody else's window.
    const { client, calls } = fakeCmux({
      workspaces: [
        { id: "ws-a", custom_title: "operations-old" },
        { id: "ws-b", custom_title: "my-operations" },
        { id: "ws-c", custom_title: null },
      ],
    });

    const result = await ensureOperations(client, OPTS);

    expect(result.created).toBe(true);
    expect(verbsOf(calls)).toContain("workspace create");
  });
});

describe("creating the workspace", () => {
  test("issues one create, three splits and four respawns, in pane order", async () => {
    const { client, calls } = fakeCmux();

    const result = await ensureOperations(client, OPTS);

    expect(result).toEqual({ created: true, workspaceId: "ws-new" });
    expect(verbsOf(calls)).toEqual([
      "workspace list",
      "workspace create",
      // pane 1 consumes the surface `workspace create` opened with — no split.
      "rename-tab",
      "respawn-pane",
      "new-split",
      "rename-tab",
      "respawn-pane",
      "new-split",
      "rename-tab",
      "respawn-pane",
      "new-split",
      "rename-tab",
      "respawn-pane",
      "select-workspace",
      "list-panes",
      "focus-pane",
      // The SECOND `list-panes` reads pane geometry for the top-row resize.
      // No `resize-pane` follows it here: this fake returns no
      // `container_frame`, the geometry parse throws, and the resize is
      // best-effort by design — a console whose panes are all correct but
      // evenly split is fully usable, so a cosmetic failure must not take the
      // workspace down with it. The call being ISSUED is what this pins.
      "list-panes",
    ]);
  });

  test("the operator lands in pane 1, not in whichever pane was split last", async () => {
    // MEASURED, not anticipated: the first live run left focus on pane 3, the
    // git watch — the one pane that ignores input. Every `new-split` moves
    // focus to the pane it creates, and `--focus false` on `workspace create`
    // governs the workspace, not the splits.
    const { client, calls } = fakeCmux();
    await ensureOperations(client, OPTS);
    const focus = calls.find((c) => verb(["cmux", ...c]) === "focus-pane");
    expect(focus, "no focus-pane call — the operator lands wherever cmux left them").toBeDefined();
    // pane-0 is the one holding the INITIAL surface, and it is listed last by
    // the fake, so an implementation that took `panes[0]` would focus pane-1.
    expect(focus![focus!.indexOf("--pane") + 1]).toBe("pane-0");
  });

  test("the workspace is created on the INVOCATION directory", async () => {
    const { client, calls } = fakeCmux();
    await ensureOperations(client, OPTS);
    const create = calls.find((c) => verb(["cmux", ...c]) === "workspace create")!;
    expect(create).toContain("--cwd");
    expect(create[create.indexOf("--cwd") + 1]).toBe(CWD);
    // `--name` is what `findWorkspaceByTitle` will match on next time.
    expect(create[create.indexOf("--name") + 1]).toBe("operations");
    // Never steal focus while building; the workspace is selected at the end.
    expect(create[create.indexOf("--focus") + 1]).toBe("false");
  });

  test("pane 1 gets the initial surface, and each split anchors on the previous one", async () => {
    const { client, calls } = fakeCmux();
    await ensureOperations(client, OPTS);

    const respawns = calls.filter((c) => verb(["cmux", ...c]) === "respawn-pane");
    const surfaceOf = (c: string[]) => c[c.indexOf("--surface") + 1];
    // surf-0 is the create's own surface; the rest come from splits. A stale
    // anchor would repeat an id here.
    expect(respawns.map(surfaceOf)).toEqual(["surf-0", "surf-1", "surf-2", "surf-3"]);

    const splits = calls.filter((c) => verb(["cmux", ...c]) === "new-split");
    expect(splits.map((c) => c[1])).toEqual(["left", "down", "down"]);
    /*
     * THE ANCHORS ARE THE WHOLE TEST, and the third is why `splitFrom` exists.
     *
     *   left  off surf-0 — ticketing lands to the LEFT of the observer
     *   down  off surf-1 — fleet-status lands under TICKETING, the left column
     *   down  off surf-0 — git-watch lands under the OBSERVER, the right column
     *
     * That last one does not anchor on the pane before it. Splitting off
     * surf-2 would stack a third row inside the left column and leave the
     * right column full height — a 3+1 layout that still passes any assertion
     * checking only the directions.
     */
    expect(splits.map(surfaceOf)).toEqual(["surf-0", "surf-1", "surf-0"]);
  });

  test("each pane is renamed before its shell is replaced", async () => {
    const { client, calls } = fakeCmux();
    await ensureOperations(client, OPTS);
    const titles = calls
      .filter((c) => verb(["cmux", ...c]) === "rename-tab")
      .map((c) => c[c.indexOf("--title") + 1]);
    expect(titles).toEqual(["observer", "ticketing", "fleet-status", "git-watch"]);
  });

  test("each pane's command reaches the pane that was created for it", async () => {
    const { client, calls } = fakeCmux();
    await ensureOperations(client, OPTS);
    const commands = calls
      .filter((c) => verb(["cmux", ...c]) === "respawn-pane")
      .map((c) => c[c.indexOf("--command") + 1]!);
    // The head of DEFAULT_OPERATIONS_WORKERS, not a literal. This assertion
    // named "tick-1" by hand and went stale the moment the default moved,
    // which is the same second-copy defect that let the console bring up one
    // worker while resolving its pane mode from another.
    // One worker per agent pane, each with its own `up` — two attended panes
    // are two runs, because --attach-here hands over one process's terminal.
    expect(commands[0]).toContain(`'--workers' '${DEFAULT_OPERATIONS_WORKERS[0]}'`);
    expect(commands[1]).toContain(`'--workers' '${DEFAULT_OPERATIONS_WORKERS[1]}'`);
    expect(commands[2]).toContain("'status'");
    expect(commands[3]).toContain(`-C '${CWD}'`);
  });
});

describe("reachability", () => {
  test("a refused socket is a false, not a throw", async () => {
    // Measured 2026-08-30: with the app closed every verb fails identically
    // with `Connection refused`. Probing once turns eight identical errors
    // into one sentence and an exit code.
    const client = new CmuxClient({
      exec: async () => ({ code: 1, stdout: "", stderr: "Connection refused", timedOut: false }),
    });
    expect(await cmuxReachable(client)).toBe(false);
  });

  test("a listening cmux is a true", async () => {
    expect(await cmuxReachable(fakeCmux().client)).toBe(true);
  });
});
