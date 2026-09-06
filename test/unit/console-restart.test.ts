/**
 * Restarting ONE console pane, and addressing it by the right thing.
 *
 * `--recreate` was the only repair a console had for a worker that did not
 * come back, and it costs every other pane to fix one. `--restart <title>` is
 * the narrow version, which means it needs an answer to a question
 * `--recreate` never had to ask: WHICH pane is this worker?
 *
 * The answer is not the index, and that is what most of this file is about.
 * Measured on the live development console 2026-09-04, when the `--workers`
 * order was `eng-1,eng-2,tst-1,rev-1`; the fourth seat is now `tst-2` and the
 * rename moved no pane, so the mapping is reproduced with the current id:
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
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { CmuxClient, listPaneSurfacesArgv } from "../../src/backends/cmux/client.ts";
import type { ExecResult } from "../../src/container/run.ts";
import { parsePaneSurfaces } from "../../src/backends/cmux/parse.ts";
import {
  DEVELOPMENT_SPEC,
  OPERATIONS_SPEC,
  REVIEW_SPEC,
  plannedPane,
  restartConsolePane,
  surfaceForTitle,
  titledPanes,
} from "../../src/backends/cmux/operations.ts";
import {
  DEFAULT_OPERATIONS_WORKERS,
  operationsPanes,
} from "../../src/backends/cmux/operations-plan.ts";

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
  { pane: "pane-d", surface: "surf-tst-2", title: "tst-2" },
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
          { id: "s-1", index: 0, selected: true, title: "tst-2", type: "terminal" },
        ],
      }),
    );
    expect(out).toEqual([{ surfaceId: "s-1", title: "tst-2", selected: true }]);
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
    expect(panes.map((p) => p.title)).toEqual(["eng-1", "tst-1", "eng-2", "tst-2"]);
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
  test("it respawns tst-2's surface and no other", async () => {
    const { client, calls } = fakeCmux();
    const r = await restartConsolePane(client, DEVELOPMENT_SPEC, OPTS, "tst-2");
    expect(r.surfaceId).toBe("surf-tst-2");

    const respawns = calls.filter((c) => c[0] === "respawn-pane");
    expect(respawns.length).toBe(1);
    expect(respawns[0]?.[respawns[0]!.indexOf("--surface") + 1]).toBe("surf-tst-2");
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
    await restartConsolePane(client, DEVELOPMENT_SPEC, OPTS, "tst-2");
    const respawn = calls.find((c) => c[0] === "respawn-pane")!;
    const command = respawn[respawn.indexOf("--command") + 1] ?? "";
    expect(command).toContain("tst-2");
    expect(command).toContain("up");
  });

  test("nothing is created, split or closed", async () => {
    const { client, calls } = fakeCmux();
    await restartConsolePane(client, DEVELOPMENT_SPEC, OPTS, "tst-2");
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
    await expect(restartConsolePane(client, DEVELOPMENT_SPEC, OPTS, "tst-2")).rejects.toThrow(
      /which holds eng-1, tst-1/,
    );
  });

  test("no open console is refused before any pane call is made", async () => {
    const { client, calls } = fakeCmux({ workspaces: [] });
    await expect(restartConsolePane(client, DEVELOPMENT_SPEC, OPTS, "tst-2")).rejects.toThrow(
      /no development workspace is open/,
    );
    expect(calls.map((c) => c[0])).not.toContain("respawn-pane");
  });
});

/**
 * REFUSING BEFORE DESTROYING — measured 2026-09-06.
 *
 * `./scripts/operations --restart obs-1` printed, in this order:
 *
 *   operations: stopping run 2026-09-04T18-03-52Z-e2fc before restarting obs-1
 *   operations: 'obs-1' is not a pane this console plans — it holds observer, monitor, ticketing
 *
 * Both operations workers were left DOWN with nothing respawned. The refusal
 * above was already correct and already tested; it just arrived after the only
 * irreversible step. The two lookups key on different things — the teardown on
 * WORKER ID via `runsHoldingAny`, the respawn on PANE TITLE via the plan — and
 * on this console those namespaces do not overlap.
 *
 * The instance is narrow, the shape is not: any live worker id a console does
 * not plan reaches it, including one console asked for another console's
 * worker, and on `review` the relay is stopped first as well.
 */
describe("a restart resolves its title before it stops anything", () => {
  test("the operations console does not plan its own workers by id", () => {
    /*
     * The premise the bug stands on, asserted rather than assumed. If these
     * ever converge — panes retitled to worker ids — this test is the thing
     * that says the trap has moved, rather than the ordering tests quietly
     * passing on a fixture where both lookups agree.
     */
    const titles = operationsPanes({ ...OPTS, workspaceName: "operations" }).map((x) => x.title);
    expect(titles).toContain("observer");
    for (const worker of DEFAULT_OPERATIONS_WORKERS) {
      expect(titles).not.toContain(worker);
    }
  });

  test("plannedPane returns the pane, and its command, for a title the console builds", () => {
    expect(plannedPane(DEVELOPMENT_SPEC, OPTS, "tst-2").title).toBe("tst-2");
    expect(plannedPane(OPERATIONS_SPEC, OPTS, "observer").command).toContain("up");
  });

  test("the measured case refuses, naming what operations does hold", () => {
    expect(() => plannedPane(OPERATIONS_SPEC, OPTS, "obs-1")).toThrow(
      /not a pane this console plans/,
    );
    expect(() => plannedPane(OPERATIONS_SPEC, OPTS, "obs-1")).toThrow(/observer/);
  });

  test("a console asked for another console's live worker refuses too", () => {
    expect(() => plannedPane(DEVELOPMENT_SPEC, OPTS, "obs-1")).toThrow(
      /not a pane this console plans/,
    );
    expect(() => plannedPane(REVIEW_SPEC, OPTS, "eng-1")).toThrow(
      /not a pane this console plans/,
    );
  });
});

/*
 * WHAT IS LEFT FOR THE SOURCE TO ANSWER, AND WHY IT IS SO LITTLE.
 *
 * The scripts run `main()` at import, so no test can call their restart path —
 * the reason `review-console-relay.test.ts` states for keeping decisions in
 * modules. The ORDERING used to be one of the things no module held, so it was
 * checked here by reading the scripts and comparing `indexOf` positions. That
 * check had two silent false-pass modes and a reviewer found both:
 *
 *   1. it asserted only that the substring `plannedPane(` appeared before the
 *      destructive ones, so ANY call satisfied it — the wrong spec, the wrong
 *      title, or a call inside a `try` that swallowed the throw;
 *   2. it read `if (at === -1) continue;`, so extracting `runsHoldingAny(` into
 *      a helper made `indexOf` return -1 and the assertion was SKIPPED. The
 *      guard would have been gone and the suite green.
 *
 * `resolveThenRestart` now owns the ordering and `test/unit/fresh-dispatch.test.ts`
 * asserts it against real calls: that the resolution precedes every irreversible
 * step, that a refused title stops neither the run nor the relay, and that the
 * respawn follows the teardown. Those are the tests that answer "is the order
 * right".
 *
 * What no module can answer is whether the SCRIPTS still delegate — a script
 * that re-inlines a step is back where it started with the module sitting
 * unused beside it — and that is now asked of three things: the bare path's
 * whole sequence, the title resolution the `--task` path must do itself because
 * its module takes no `plan` dep, and the relay stop `review` hands over rather
 * than performing on the line above the call. Those three facts are checked
 * against the source, and a marker that cannot be found FAILS. It never skips:
 * a marker that has moved means the check this file used to perform is gone,
 * and reporting that as a pass is how a guard disappears without anyone finding
 * out.
 */
describe("every console script hands its --restart ordering to the module", () => {
  const BRANCH = 'const restartFlag = flag(argv, "--restart");';
  const TASK_PATH = "if (taskFlag !== undefined) {";

  const source = (script: string): Promise<string> =>
    readFile(join(import.meta.dir, "..", "..", "scripts", script), "utf8");

  /**
   * Where `needle` next appears, THROWING when it does not.
   *
   * The whole point of the helper. `indexOf` answers -1 for something absent,
   * -1 is less than every real index, and an ordering assertion built on it
   * passes most confidently exactly when the thing it orders has been deleted.
   */
  const at = (src: string, needle: string, from: number, why: string): number => {
    const i = src.indexOf(needle, from);
    if (i === -1) {
      throw new Error(`the marker '${needle}' is not in this script after ${from} — ${why}`);
    }
    return i;
  };

  for (const script of ["operations", "development", "review"]) {
    test(`scripts/${script} gives the bare --restart to resolveThenRestart`, async () => {
      const src = await source(script);
      const branch = at(src, BRANCH, 0, "the --restart branch is not where it was");
      at(
        src,
        "resolveThenRestart(",
        branch,
        "the bare --restart path must be the module's ordering, not four statements here",
      );
    });

    test(`scripts/${script} no longer resolves its own teardown after --restart`, async () => {
      /*
       * `runsHoldingAny` still scopes the `--recreate` sweep, which sits ABOVE
       * this branch — so its absence is asserted from the branch onward rather
       * than over the whole file. A second appearance below the branch is the
       * sequence being re-inlined, which is the regression this fix exists to
       * make impossible to reach by accident.
       */
      const src = await source(script);
      const branch = at(src, BRANCH, 0, "the --restart branch is not where it was");
      expect(src.indexOf("runsHoldingAny(", branch)).toBe(-1);
      expect(src.indexOf("runsHoldingAny(")).toBeGreaterThan(-1); // still scoping --recreate
    });

    test(`scripts/${script} resolves the title before recreateThenDispatch`, async () => {
      /*
       * The one ordering the source still has to answer for: the `--task`
       * module takes no `plan` dep — it waits, and a wait of up to twenty
       * minutes before an unplannable title is refused would be worse than
       * useless — so the script calls the resolution itself, first.
       */
      const src = await source(script);
      const branch = at(src, BRANCH, 0, "the --restart branch is not where it was");
      const task = at(src, TASK_PATH, branch, "the --task path has moved out of the branch");
      const resolved = at(
        src,
        "plan();",
        task,
        "the --task path must resolve the title itself; the module it calls does not",
      );
      const dispatch = at(src, "recreateThenDispatch(", task, "the --task path calls no module");
      expect(resolved).toBeLessThan(dispatch);
    });
  }

  test("scripts/review hands its --task relay stop to the module instead of calling it", async () => {
    /*
     * THIS TEST USED TO ASSERT THE OPPOSITE, and was right to at the time.
     *
     * `review` stopped the relay itself, on the line before `recreateThenDispatch`,
     * and what this file checked was that the title was resolved before that
     * happened. Both facts were true and the ordering was still wrong one level
     * out: the module's wait can run for twenty minutes and then refuse, saying
     * *"Nothing has been stopped"* — and on this console it had been. The relay
     * was gone before the wait began, so the refusal left four healthy workers
     * and nothing able to turn a collator's dispatch request into reviews.
     *
     * The stop is now a dep, fired between the settled wait and the teardown,
     * and its POSITION is asserted in `test/unit/fresh-dispatch.test.ts` against
     * recorded calls rather than against source text — the same treatment the
     * bare path already gets from `resolveThenRestart`. What is left for this
     * file is the one thing no module can answer: that the script delegates at
     * all, rather than re-inlining the stop beside a module that also does it.
     *
     * The two spans are bounded by markers that THROW when missing, and the
     * `not.toContain` is deliberately the narrower of the two: it reads only as
     * far as the module call, so the dep's own `quiesce` reference below cannot
     * satisfy it and a re-inlined stop cannot hide behind it.
     */
    const src = await source("review");
    const branch = at(src, BRANCH, 0, "the --restart branch is not where it was");
    const task = at(src, TASK_PATH, branch, "the --task path has moved out of the branch");
    const call = at(src, "recreateThenDispatch(", task, "the --task path calls no module");
    const opts = at(
      src,
      "{ worker: restartFlag },",
      call,
      "the --task path's dep object is not closed by the options argument",
    );

    // Nothing between entering the branch and calling the module may stop it.
    expect(src.slice(task, call)).not.toContain("quiesce(");
    // And the module is given it, so the module decides when.
    expect(src.slice(call, opts)).toContain("quiesce");
  });
});
