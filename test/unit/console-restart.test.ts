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

  /**
   * The PROPERTY is unchanged — an unplannable name refuses before anything is
   * destroyed — but `obs-1` is no longer an example of one. ISC-1106 made the
   * operations console accept its workers' ids as well as its pane titles,
   * because refusing the id while the title silently orphaned the container was
   * the trap that left two live runs for one worker, twice. So the refusal is
   * re-pinned on a name no console builds.
   */
  test("the measured case refuses, naming what operations does hold", () => {
    expect(() => plannedPane(OPERATIONS_SPEC, OPTS, "obs-9")).toThrow(
      /not a pane this console plans/,
    );
    expect(() => plannedPane(OPERATIONS_SPEC, OPTS, "obs-9")).toThrow(/observer/);
  });

  /**
   * ISC-1106. `--restart obs-1` used to be refused as "not a pane this console
   * plans" while `--restart observer` respawned the pane and stopped nothing —
   * so the console had no safe restart path at all. Both spellings now resolve
   * to the same pane, and the pane knows which worker it runs.
   */
  test("operations resolves a pane by worker id as well as by title", () => {
    const byTitle = plannedPane(OPERATIONS_SPEC, OPTS, "observer");
    const byWorker = plannedPane(OPERATIONS_SPEC, OPTS, "obs-1");
    expect(byWorker.title).toBe("observer");
    expect(byWorker.command).toBe(byTitle.command);
    expect(byTitle.worker).toBe("obs-1");
    expect(plannedPane(OPERATIONS_SPEC, OPTS, "ticketing").worker).toBe("tick-1");
  });

  /** A pane that runs no worker says so, rather than being given its own title. */
  test("the monitor pane carries no worker", () => {
    expect(plannedPane(OPERATIONS_SPEC, OPTS, "monitor").worker).toBeUndefined();
  });

  /** On the agent-square consoles the two spellings coincide, and must stay equal. */
  test("an agent-square pane's worker is its title", () => {
    const p = plannedPane(DEVELOPMENT_SPEC, OPTS, "tst-2");
    expect(p.worker).toBe("tst-2");
    expect(p.worker).toBe(p.title);
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

  for (const script of ["operations", "development", "review", "triage"]) {
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

  /**
   * ISC-1106 — OPERATIONS ONLY, and the scoping is the point.
   *
   * On `review`, `development` and `triage` a pane's title IS its worker id, so
   * `{ worker: restartFlag }` is accidentally correct there and pinning this
   * across all four would fail on three consoles that have no defect. Only
   * `operations` titles its panes by ROLE while running ids, and only it
   * orphaned containers as a result.
   *
   * A SOURCE probe because nothing else can be: `scripts/` is outside
   * `tsconfig`'s `include` and the scripts are not importable, so
   * `tsc --listFiles` never names this file and no unit test can call into it.
   * The defect was invisible for exactly that reason — `{ worker: restartFlag }`
   * type-checks nowhere and reads fine.
   */
  /**
   * ISC-1057 — the third arm of the mismatch message.
   *
   * `servesConsole` compares console, run and worker coverage. The message the
   * script prints when it replaces an actor only distinguished the first two, so
   * a WORKERS mismatch fell through to the run arm and printed
   * `serves run r-1, not this console's r-1` — the same id twice. That is the
   * reading the surrounding comment calls "a bug in the script": an operator
   * watching a healthy actor be replaced was told the runs differed when they
   * did not. Source-level because `scripts/` is outside `tsconfig`'s `include`
   * and unimportable.
   */
  test("scripts/triage names a worker mismatch instead of blaming the run", async () => {
    const src = await source("triage");
    const start = at(src, "const mismatch =", 0, "scripts/triage builds no mismatch message");
    const end = at(src, "stopActor(", start, "the mismatch message reaches no stop");
    const expr = src.slice(start, end);
    expect(expr).toContain("does not serve");
    expect(expr).toContain("existing.record.workers");
    // The run arm must still be CONDITIONAL, or the workers arm is unreachable.
    expect(expr).toContain("existing.record.run_id !== runId");
  });

  /**
   * The same block referenced `triageWorkers`, which is `main`'s local and not
   * in `startActor`'s scope — a ReferenceError at the moment an operator is
   * being told why their actor is being replaced. Nothing else would catch it:
   * this file is not typechecked and not importable.
   */
  test("scripts/triage's startActor uses its own workers parameter", async () => {
    const src = await source("triage");
    const fn = at(src, "async function startActor(", 0, "scripts/triage defines no startActor");
    const end = at(src, "\nasync function ", fn + 10, "startActor is never closed by another function");
    expect(src.slice(fn, end)).not.toContain("triageWorkers");
  });

  test("scripts/operations hands the modules a WORKER ID, not a pane title", async () => {
    const src = await source("operations");
    const branch = at(src, BRANCH, 0, "the --restart branch is not where it was");
    const after = src.slice(branch);
    expect(after).not.toContain("{ worker: restartFlag }");
    expect(after).toContain("{ worker: targetWorker }");
    expect(after).not.toContain('"--worker", restartFlag');
    expect(after).toContain('"--worker", targetWorker');
  });

  /**
   * ── THE ISC-572 ORDERING, ON EVERY CONSOLE THAT HAS AN ACTOR ───────────────
   *
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
   * ## IT IS A LOOP BECAUSE THE SAME DEFECT ON A FOURTH CONSOLE IS THE ONE
   * MOST LIKELY TO SHIP
   *
   * ISC-572 was filed on `review` and closed there. `triage` is the second
   * console with a fifth process, its script is a copy of `review`'s, and
   * SRD-TRIAGE-CONSOLE §6.4 says so in as many words: *"Getting this wrong on a
   * fourth console is the same defect a fourth time, and it is the reason §13
   * Phase 4 names the test before the script."* A per-console copy of this test
   * would be the same copy-paste one level up, so the two consoles that HAVE an
   * actor are a list here and the two that do not are absent from it — and
   * `fresh-dispatch.test.ts` is what checks that the absent two say `null`
   * rather than merely omitting the field.
   *
   * ## THE POSITIVE ARM IS STRUCTURAL, WHICH IT WAS NOT
   *
   * The two spans are bounded by markers that THROW when missing, and the
   * `not.toContain` is deliberately the narrower of the two: it reads only as
   * far as the module call, so the dep's own `quiesce` reference below cannot
   * satisfy it and a re-inlined stop cannot hide behind it.
   *
   * The arm below it used to be `expect(src.slice(call, opts)).toContain("quiesce")`,
   * and ISC-572 records what that cost: a wider span was satisfied by the
   * literal `quiesce,` inside an intervening prose comment. Narrowing the span
   * did not remove the hole, it only moved it — the deps object is full of
   * comments too, and one of them saying "quiesce" would still be green with the
   * property deleted. So the arm now reads LINES and requires one whose trimmed
   * text BEGINS with the property name: `// quiesce, ...` trims to `// quiesce`
   * and ` * quiesce,` trims to `* quiesce,`, and neither begins with `quiesce`.
   */
  for (const script of ["review", "triage"]) {
    test(`scripts/${script} hands its --task actor stop to the module instead of calling it`, async () => {
      const src = await source(script);
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

      // And the module is given it, so the module decides when. A LINE that
      // starts with the property, so no comment in the dep object can stand in
      // for the property itself.
      const depLines = src
        .slice(call, opts)
        .split("\n")
        .map((l) => l.trim())
        .filter((l) => l.startsWith("quiesce"));
      if (depLines.length === 0) {
        throw new Error(
          `scripts/${script}'s recreateThenDispatch dep object has no quiesce property — ` +
            `the stop is not handed over, and a comment mentioning it does not count`,
        );
      }
    });
  }

  /**
   * ── §13 TASK 4.5a(b): TWO PROBES FOR ISC-572 ON TRIAGE, AND WHICH IS
   * LOAD-BEARING FOR WHAT ─────────────────────────────────────────────────────
   *
   * §13 task 4.5a(b) — pinned on the task label, not a line range, because
   * `§13:2938-2940` rotted: that range now holds task 2.1 (`TRIAGE_CONSOLE_ROSTER`)
   * and the quoted sentence moved to roughly `:3182-3184`. Found 2026-09-11 by the
   * audit of the sibling citation in `fresh-dispatch.test.ts`, which had drifted the
   * same way: *"`test/unit/console-restart.test.ts:471` asserts ISC-572 for
   * triage by reading source text, while `test/integration/triage-console.test.ts`
   * now EXECUTES it — keep both and say which is load-bearing."* Both run in CI
   * (`.github/workflows/ci.yml` runs `bun test test/unit` AND
   * `bun test test/integration`), so this is not a question of one being skipped.
   * It is a question of what each one can see, and **neither subsumes the other**:
   *
   * **The source probe above is the only one that can see the stop being
   * DROPPED.** Delete the `quiesce` property from `recreateThenDispatch`'s dep
   * object and the actor is simply never stopped — which is `quiesce: null`'s
   * behaviour, the defect ISC-572 records wearing the fix's clothes. The
   * executing test asserts the actor is *still live several polls into the
   * wait*, and an actor that is never stopped at all is **more** live, so it
   * stays green. Measured, not reasoned: with the property removed,
   * `test/integration/triage-console.test.ts` passed and this arm failed.
   *
   * **The executing test is the only one that can see the ORDER being wrong in a
   * way the markers do not span.** The source probe reads two bounded spans; a
   * stop performed through some path those spans do not cover — a different
   * helper, an earlier branch, a dep the module calls too early — is a green
   * source probe and a dead actor. The integration test watches the real record
   * across real poll cycles and does not care how the script got there.
   *
   * So: the source probe is load-bearing for **delegation**, the executing test
   * for **timing**. The one thing that would make this file's arm redundant is
   * an executing test that fails when the stop is dropped, and there is no such
   * test — you cannot observe a stop that never happens by watching a process
   * stay alive.
   *
   * ## THE CLAIM IS PINNED, BECAUSE A COMMENT CANNOT GO RED
   *
   * Two arms, and both are about the OTHER file. The first keeps *"keep both"*
   * honest: if the executing test is deleted or renamed, this reddens and names
   * it, rather than leaving a paragraph describing a test that no longer exists.
   * The second pins the division of labour itself — the integration file drives
   * `scripts/triage` as a PROCESS and never reads it as TEXT, which is exactly
   * why it cannot see a dropped dep. Someone who adds a source read there has
   * changed which probe is load-bearing, and should find a red test asking them
   * to update this paragraph rather than a stale paragraph.
   */
  test("the executing half of ISC-572 exists, and cannot see what this file sees", async () => {
    const integration = await readFile(
      join(import.meta.dir, "..", "integration", "triage-console.test.ts"),
      "utf8",
    );

    // 1. It is still there, by the name that carries the claim.
    expect(
      integration,
      "test/integration/triage-console.test.ts no longer executes the ISC-572 wait — " +
        "the source probe above is now the ONLY check on this console's actor stop",
    ).toContain("the actor is still live several polls into the wait");

    // 2. And it reads the script as a PROCESS, never as text. `source(` is this
    //    file's and `fresh-dispatch.test.ts`'s instrument; the integration file
    //    spawns `bun run scripts/triage` instead, which is what makes a dropped
    //    `quiesce` invisible to it and this file's arm irreplaceable.
    expect(integration).toContain("scripts/triage");
    expect(
      integration.includes("readFile(") || integration.includes("readFileSync("),
      "test/integration/triage-console.test.ts now reads source text — re-read task " +
        "4.5a(b): which probe is load-bearing may have changed",
    ).toBe(false);
  });
});
