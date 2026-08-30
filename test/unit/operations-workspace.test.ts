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
 * holds a live ticketing container and a shell an operator may have typed into;
 * from the outside, "refresh it" and "destroy it" are the same call. Proved by
 * mutation: making `ensureOperations` fall through to `createOperations` when a
 * workspace already exists reddens the first two tests below.
 */
import { describe, expect, test } from "bun:test";

import { CmuxClient } from "../../src/backends/cmux/client.ts";
import type { ExecResult } from "../../src/container/run.ts";
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
  test("issues one create, two splits and three respawns, in pane order", async () => {
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
      "select-workspace",
    ]);
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
    // surf-0 is the create's own surface; surf-1 and surf-2 come from the
    // splits. A stale anchor would repeat an id here.
    expect(respawns.map(surfaceOf)).toEqual(["surf-0", "surf-1", "surf-2"]);

    const splits = calls.filter((c) => verb(["cmux", ...c]) === "new-split");
    expect(splits.map((c) => c[1])).toEqual(["right", "down"]);
    expect(splits.map(surfaceOf)).toEqual(["surf-0", "surf-1"]);
  });

  test("each pane is renamed before its shell is replaced", async () => {
    const { client, calls } = fakeCmux();
    await ensureOperations(client, OPTS);
    const titles = calls
      .filter((c) => verb(["cmux", ...c]) === "rename-tab")
      .map((c) => c[c.indexOf("--title") + 1]);
    expect(titles).toEqual(["ticketing", "fleet-status", "git-watch"]);
  });

  test("the ticketing command reaches pane 1 and the git loop reaches pane 3", async () => {
    const { client, calls } = fakeCmux();
    await ensureOperations(client, OPTS);
    const commands = calls
      .filter((c) => verb(["cmux", ...c]) === "respawn-pane")
      .map((c) => c[c.indexOf("--command") + 1]!);
    expect(commands[0]).toContain("'--workers' 'tick-1'");
    expect(commands[1]).toContain("'status' '--watch'");
    expect(commands[2]).toContain(`git -C '${CWD}'`);
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
