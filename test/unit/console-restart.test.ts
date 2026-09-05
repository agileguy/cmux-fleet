/**
 * Restarting ONE console pane, and addressing it by the right thing.
 *
 * `--recreate` was the only repair a console had for a worker that did not
 * come back, and it costs every other pane to fix one. `--restart <title>` is
 * the narrow version, which means it needs an answer to a question
 * `--recreate` never had to ask: WHICH pane is this worker?
 *
 * The answer is not the index, and that is what most of this file is about.
 * Measured on the live development console 2026-09-04, whose `--workers` order
 * is `eng-1,eng-2,tst-1,tst-2`:
 *
 *   cmux index 0 -> eng-1     cmux index 1 -> tst-1
 *   cmux index 2 -> eng-2     cmux index 3 -> tst-2
 *
 * `developmentPanes` builds a 2x2 using `splitFrom`, so creation order and
 * cmux's reported index disagree, and index 1 is the THIRD worker. A restart
 * that trusted position would have torn down a live `tst-1` when asked for
 * `eng-2` — the exact failure the feature exists to avoid, at the exact moment
 * the operator is trying to be careful. `FAKE_PANES` below is that measured
 * order, not a tidy one, so a regression to index addressing reddens rather
 * than passing on a fixture that happened to agree.
 */
import { describe, expect, test } from "bun:test";

import { CmuxClient, listPaneSurfacesArgv } from "../../src/backends/cmux/client.ts";
import type { ExecResult } from "../../src/container/run.ts";
import { parsePaneSurfaces } from "../../src/backends/cmux/parse.ts";
import {
  DEVELOPMENT_SPEC,
  restartConsolePane,
  surfaceForTitle,
  titledPanes,
} from "../../src/backends/cmux/operations.ts";

const REPO = "/Users/x/repos/cmux-fleet";
const CWD = "/Users/x/repos/somewhere-else";
const OPTS = { repoRoot: REPO, watchDir: CWD };

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const verb = (argv: string[]): string =>
  argv[1] === "workspace" ? `workspace ${argv[2]}` : String(argv[1]);

/**
 * The measured pane order — index does NOT follow `--workers` order.
 * See this file's header for where these numbers come from.
 */
const FAKE_PANES: ReadonlyArray<{ pane: string; surface: string; title: string | null }> = [
  { pane: "pane-a", surface: "surf-eng-1", title: "eng-1" },
  { pane: "pane-b", surface: "surf-tst-1", title: "tst-1" },
  { pane: "pane-c", surface: "surf-eng-2", title: "eng-2" },
  { pane: "pane-d", surface: "surf-rev-1", title: "rev-1" },
];

function fakeCmux(
  opts: {
    workspaces?: Array<{ id: string; custom_title: string | null }>;
    panes?: ReadonlyArray<{ pane: string; surface: string; title: string | null }>;
  } = {},
): { client: CmuxClient; calls: string[][] } {
  const panes = opts.panes ?? FAKE_PANES;
  const calls: string[][] = [];
  const client = new CmuxClient({
    exec: async (argv) => {
      calls.push(argv.slice(1));
      switch (verb(argv)) {
        case "ping":
          return ok("");
        case "workspace list":
          return ok(
            JSON.stringify({
              window_id: "win-1",
              workspaces: opts.workspaces ?? [{ id: "ws-dev", custom_title: "development" }],
            }),
          );
        case "list-panes":
          return ok(
            JSON.stringify({
              panes: panes.map((p, i) => ({
                id: p.pane,
                selected_surface_id: p.surface,
                index: i,
              })),
            }),
          );
        case "list-pane-surfaces": {
          const paneId = argv[argv.indexOf("--pane") + 1];
          const hit = panes.find((p) => p.pane === paneId);
          return ok(
            JSON.stringify({
              pane_id: paneId,
              surfaces:
                hit === undefined
                  ? []
                  : [
                      {
                        id: hit.surface,
                        index: 0,
                        selected: true,
                        ...(hit.title === null ? {} : { title: hit.title }),
                        type: "terminal",
                      },
                    ],
            }),
          );
        }
        default:
          return ok("");
      }
    },
  });
  return { client, calls };
}

describe("list-pane-surfaces is addressed at one named pane", () => {
  test("the argv names the pane and asks for uuids", () => {
    const argv = listPaneSurfacesArgv("ws-1", "pane-9");
    expect(argv[0]).toBe("list-pane-surfaces");
    expect(argv).toContain("--pane");
    expect(argv[argv.indexOf("--pane") + 1]).toBe("pane-9");
    expect(argv[argv.indexOf("--workspace") + 1]).toBe("ws-1");
  });

  test("--pane is required, because without it cmux answers for the FOCUSED pane", () => {
    // Not a style assertion. The verb succeeds with no `--pane` and returns a
    // different pane's title, so an omission here would not fail loudly — it
    // would restart whichever pane the operator last clicked.
    expect(listPaneSurfacesArgv("ws-1", "pane-9")).toContain("--pane");
  });

  test("a pane id carrying a flag is refused rather than passed through", () => {
    expect(() => listPaneSurfacesArgv("ws-1", "--command rm -rf /")).toThrow();
  });
});

describe("parsing one pane's surfaces", () => {
  test("id, title and selection are read", () => {
    const out = parsePaneSurfaces(
      JSON.stringify({
        surfaces: [
          { id: "s-1", index: 0, selected: true, title: "rev-1", type: "terminal" },
        ],
      }),
    );
    expect(out).toEqual([{ surfaceId: "s-1", title: "rev-1", selected: true }]);
  });

  test("an untitled surface is KEPT with a null title, not dropped", () => {
    // A console whose titles never landed and a worker id that does not exist
    // want opposite fixes. Dropping the untitled surface here makes them look
    // identical to the caller.
    const out = parsePaneSurfaces(JSON.stringify({ surfaces: [{ id: "s-1", index: 0 }] }));
    expect(out).toEqual([{ surfaceId: "s-1", title: null, selected: false }]);
  });

  test("output with no surfaces array is a parse error, not an empty list", () => {
    expect(() => parsePaneSurfaces(JSON.stringify({ pane_id: "p" }))).toThrow();
  });
});

describe("a pane is found by its title, never by its position", () => {
  test("every pane resolves to the worker whose title it carries", async () => {
    const { client } = fakeCmux();
    const panes = await titledPanes(client, "ws-dev");
    expect(panes.map((p) => p.title)).toEqual(["eng-1", "tst-1", "eng-2", "rev-1"]);
  });

  test("eng-2 resolves to its own surface, NOT to the pane at the plan's index 1", async () => {
    // The plan's second worker is eng-2; cmux's second pane is tst-1. This is
    // the whole hazard in one assertion.
    const { client } = fakeCmux();
    const panes = await titledPanes(client, "ws-dev");
    expect(surfaceForTitle(panes, "eng-2")).toBe("surf-eng-2");
    expect(panes[1]?.title).toBe("tst-1");
  });

  test("a title nothing carries resolves to null", async () => {
    const { client } = fakeCmux();
    expect(surfaceForTitle(await titledPanes(client, "ws-dev"), "nope")).toBeNull();
  });
});

describe("restarting one pane touches exactly one pane", () => {
  test("it respawns rev-1's surface and no other", async () => {
    const { client, calls } = fakeCmux();
    const r = await restartConsolePane(client, DEVELOPMENT_SPEC, OPTS, "rev-1");
    expect(r.surfaceId).toBe("surf-rev-1");

    const respawns = calls.filter((c) => c[0] === "respawn-pane");
    expect(respawns.length).toBe(1);
    expect(respawns[0]?.[respawns[0]!.indexOf("--surface") + 1]).toBe("surf-rev-1");
  });

  test("asking for eng-2 respawns eng-2's surface, not the second pane's", async () => {
    // The regression this file exists for: index addressing would send this
    // respawn to `surf-tst-1` and kill a live tester.
    const { client, calls } = fakeCmux();
    await restartConsolePane(client, DEVELOPMENT_SPEC, OPTS, "eng-2");
    const respawn = calls.find((c) => c[0] === "respawn-pane")!;
    expect(respawn[respawn.indexOf("--surface") + 1]).toBe("surf-eng-2");
    expect(respawn[respawn.indexOf("--surface") + 1]).not.toBe("surf-tst-1");
  });

  test("the command respawned is the plan's command for that worker", async () => {
    const { client, calls } = fakeCmux();
    await restartConsolePane(client, DEVELOPMENT_SPEC, OPTS, "rev-1");
    const respawn = calls.find((c) => c[0] === "respawn-pane")!;
    const command = respawn[respawn.indexOf("--command") + 1] ?? "";
    expect(command).toContain("rev-1");
    expect(command).toContain("up");
  });

  test("nothing is created, split or closed", async () => {
    const { client, calls } = fakeCmux();
    await restartConsolePane(client, DEVELOPMENT_SPEC, OPTS, "rev-1");
    const verbs = calls.map((c) => (c[0] === "workspace" ? `workspace ${c[1]}` : c[0]));
    expect(verbs).not.toContain("new-split");
    expect(verbs).not.toContain("workspace create");
    expect(verbs).not.toContain("workspace close");
  });
});

describe("a restart that cannot name its pane refuses, and says what is there", () => {
  test("a title the console does not plan is refused with the ones it does", async () => {
    const { client } = fakeCmux();
    await expect(restartConsolePane(client, DEVELOPMENT_SPEC, OPTS, "obs-1")).rejects.toThrow(
      /not a pane this console plans/,
    );
  });

  test("a planned worker whose pane is absent names what the console holds", async () => {
    // The open console was built with a different --workers set. "not found"
    // would send the operator to check their spelling; the fix is --recreate.
    const { client } = fakeCmux({
      panes: [
        { pane: "pane-a", surface: "surf-eng-1", title: "eng-1" },
        { pane: "pane-b", surface: "surf-tst-1", title: "tst-1" },
      ],
    });
    await expect(restartConsolePane(client, DEVELOPMENT_SPEC, OPTS, "rev-1")).rejects.toThrow(
      /which holds eng-1, tst-1/,
    );
  });

  test("no open console is refused before any pane call is made", async () => {
    const { client, calls } = fakeCmux({ workspaces: [] });
    await expect(restartConsolePane(client, DEVELOPMENT_SPEC, OPTS, "rev-1")).rejects.toThrow(
      /no development workspace is open/,
    );
    expect(calls.map((c) => c[0])).not.toContain("respawn-pane");
  });
});
