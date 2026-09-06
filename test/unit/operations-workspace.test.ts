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
import {
  DEFAULT_OPERATIONS_WORKERS,
  DEFAULT_TRIAGE_WORKERS,
} from "../../src/backends/cmux/operations-plan.ts";
import {
  TRIAGE_SPEC,
  cmuxReachable,
  createWorkspace,
  ensureOperations,
  ensureTriage,
  selectWorkspaceArgv,
} from "../../src/backends/cmux/operations.ts";

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
      // Two splits, not three: `fleet-status` and `git-watch` merged into the
      // single `monitor` pane (SRD-FLEET-MONITOR). The count is asserted rather
      // than the shape so a pane silently reappearing is caught here too.
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
    expect(respawns.map(surfaceOf)).toEqual(["surf-0", "surf-1", "surf-2"]);

    const splits = calls.filter((c) => verb(["cmux", ...c]) === "new-split");
    expect(splits.map((c) => c[1])).toEqual(["down", "left"]);
    /*
     * THE ANCHORS ARE THE WHOLE TEST.
     *
     *   down  off surf-0 — the monitor takes the WHOLE bottom
     *   left  off surf-0 — ticketing divides what is left, the TOP half
     *
     * **Both anchor on surf-0, and the second one is why `splitFrom` exists.**
     * The pane before `ticketing` is the monitor; splitting that would put the
     * ticketing agent in the bottom row. `splitFrom` briefly had no caller when
     * the two watcher panes merged, and the same structural need reappeared one
     * pane later for the same reason — a pane that must reach the ORIGINAL
     * surface rather than its predecessor.
     *
     * The ORDER of the two directions is the layout. `["left", "down"]` is the
     * same two values and produces a monitor in the bottom-left quarter, which
     * is what this console shipped with for one recreate.
     */
    expect(splits.map(surfaceOf)).toEqual(["surf-0", "surf-0"]);
  });

  test("each pane is renamed before its shell is replaced", async () => {
    const { client, calls } = fakeCmux();
    await ensureOperations(client, OPTS);
    const titles = calls
      .filter((c) => verb(["cmux", ...c]) === "rename-tab")
      .map((c) => c[c.indexOf("--title") + 1]);
    expect(titles).toEqual(["observer", "monitor", "ticketing"]);
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
    // Index 2, not 1: the monitor is created SECOND so its `down` split is the
    // one that decides the major axis and gives it the full-width bottom.
    expect(commands[2]).toContain(`'--workers' '${DEFAULT_OPERATIONS_WORKERS[1]}'`);
    /*
     * The third pane is the monitor, and both halves of what it replaced are
     * asserted: it is the monitor command. The `--repo` half of this went with
     * the monitor's git region on 2026-09-04 — the watched directory existed
     * only for the git strip, so there is no longer an invocation directory
     * for this pane to report on correctly or otherwise.
     */
    expect(commands[1]).toContain("'monitor'");
  });
});

/**
 * The `triage` console, driven through the same scripted `Exec`.
 *
 * ## Why this block is here rather than only in `triage-plan.test.ts`
 *
 * That file pins the PLAN — a pure function returning titles, splits and command
 * strings. It cannot see whether anything ever asks for that plan. `TRIAGE_SPEC`
 * and `ensureTriage` are the wiring between the plan and a live cmux, and a test
 * that imported the constant and asserted its three fields would prove only that
 * an object literal has the shape it was written with. So every assertion below
 * is made on the CALLS the fake actually received.
 *
 * ## The asymmetry that makes these probes mean something
 *
 * `TRIAGE_SPEC.topFraction` is `null` and `OPERATIONS_SPEC`'s is `0.65`, and
 * that difference is OBSERVABLE rather than merely declared: `applyTopFraction`
 * returns immediately on `null`, before it reads geometry, so this console
 * issues exactly ONE `list-panes` where the operations console issues two. The
 * fraction is therefore pinned by behaviour and not by reading the constant back
 * — a spec that had copied `OPERATIONS_TOP_FRACTION` reddens here.
 */
describe("the triage console is built from its own spec", () => {
  test("an existing triage workspace is adopted, and nothing is created or respawned", async () => {
    const { client, calls } = fakeCmux({
      workspaces: [
        { id: "ws-ops", custom_title: "operations" },
        { id: "ws-tri", custom_title: "triage" },
      ],
    });

    const result = await ensureTriage(client, OPTS);

    expect(result).toEqual({ created: false, workspaceId: "ws-tri" });
    // The whole verb list, not a count. This console holds four containers on
    // one run; "refresh it" and "destroy it" are the same call from outside, and
    // it is the console nobody is watching while it happens.
    expect(verbsOf(calls)).toEqual(["workspace list", "select-workspace"]);
    expect(calls[1]).toEqual(selectWorkspaceArgv("ws-tri"));
  });

  test("…unless --recreate, which BUILDS first and closes the old one second", async () => {
    /*
     * The `recreate` parameter is EXERCISED rather than merely accepted. Without
     * this the argument could be dropped on the floor — `ensureWorkspace(client,
     * TRIAGE_SPEC, opts)` with no fourth argument typechecks, keeps every other
     * probe in this block green, and silently turns the one flag that repairs a
     * stale console into a no-op.
     *
     * The order is the operations console's measured lesson, and it is stated
     * once in `ensureWorkspace` precisely so a fourth console cannot get it
     * backwards: closing first on a machine where this is the only workspace
     * leaves cmux with no window, and every later call fails with `TabManager
     * not available` — including the create that was meant to rebuild it.
     */
    const { client, calls } = fakeCmux({
      workspaces: [{ id: "ws-tri", custom_title: "triage" }],
    });

    const result = await ensureTriage(client, OPTS, true);

    expect(result.created).toBe(true);
    const verbs = verbsOf(calls);
    expect(verbs).toContain("workspace close");
    expect(verbs.indexOf("workspace create")).toBeLessThan(verbs.indexOf("workspace close"));
    // By the OLD id, never by a re-query: the only moment two workspaces share
    // this title is between those two calls.
    expect(calls[verbs.indexOf("workspace close")]).toEqual(["workspace", "close", "ws-tri"]);
  });

  test("a review workspace is NOT adopted as this console's", async () => {
    // Four consoles now share one adoption rule, and it is an exact match on
    // `custom_title`. A prefix or substring rule would let any two of the four
    // adopt each other and split this console's panes into the review console's
    // window — with four `pifleet up` commands respawned over whatever was in
    // them.
    const { client, calls } = fakeCmux({
      workspaces: [
        { id: "ws-rev", custom_title: "review" },
        { id: "ws-dev", custom_title: "development" },
        { id: "ws-t", custom_title: "triage-old" },
      ],
    });

    const result = await ensureTriage(client, OPTS);

    expect(result).toEqual({ created: true, workspaceId: "ws-new" });
    expect(verbsOf(calls)).toContain("workspace create");
  });

  test("issues one create, three splits and four respawns — and only ONE list-panes", async () => {
    const { client, calls } = fakeCmux();

    const result = await ensureTriage(client, OPTS);

    expect(result).toEqual({ created: true, workspaceId: "ws-new" });
    expect(verbsOf(calls)).toEqual([
      "workspace list",
      "workspace create",
      // Pane 1 consumes the surface `workspace create` opened with — no split.
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
      // ONE `list-panes`, for the focus lookup, and no second one for geometry.
      // The operations console's equivalent test pins TWO, because its
      // `topFraction` is 0.65 and `applyTopFraction` reads geometry to correct
      // it. `null` returns before that read, so the absence of a second call is
      // this spec's fraction asserted through behaviour.
      "list-panes",
      "focus-pane",
    ]);
  });

  test("the four named seats get the four panes, in pane order", async () => {
    const { client, calls } = fakeCmux();
    await ensureTriage(client, OPTS);

    const titles = calls
      .filter((c) => verb(["cmux", ...c]) === "rename-tab")
      .map((c) => c[c.indexOf("--title") + 1]);
    // THE NAMED SEATS, never a count: three consoles are one function call apart
    // and a spec pointed at the wrong constant would still produce four panes in
    // a 2x2 and stand up the wrong fleet.
    expect(titles).toEqual(["tri-1", "obs-t1", "obs-t2", "obs-t3"]);
    // …and against the exported default rather than only against literals, so a
    // seat renamed in the plan and not here is a red test rather than a console
    // whose panes are titled for workers it never starts.
    expect(titles).toEqual([...DEFAULT_TRIAGE_WORKERS]);
  });

  test("each seat's own `up` reaches the pane that was created for it", async () => {
    const { client, calls } = fakeCmux();
    await ensureTriage(client, OPTS);

    const commands = calls
      .filter((c) => verb(["cmux", ...c]) === "respawn-pane")
      .map((c) => c[c.indexOf("--command") + 1]!);

    expect(commands).toHaveLength(DEFAULT_TRIAGE_WORKERS.length);
    DEFAULT_TRIAGE_WORKERS.forEach((worker, i) => {
      expect(commands[i]).toContain(`'--workers' '${worker}'`);
    });
    /*
     * NOT ONE KEYBOARD, which is this console's defining property and the reason
     * it is one run rather than four. `--attach-here` is what would make a seat
     * `tui` in practice, and `tui` allocates no epoch: without the
     * `already_completed` fence a re-dispatched sweep runs twice, which a console
     * dispatching 288 times a day is the least able thing in this fleet to
     * afford (SRD-TRIAGE-CONSOLE §2.3).
     *
     * Asserted HERE as well as in `triage-plan.test.ts` because the two claims
     * differ: that file pins the plan's default, and this pins that the caller
     * on the ensure path adds no `tuiWorkers` of its own.
     */
    for (const c of commands) expect(c).not.toContain("'--attach-here'");
  });

  test("the square is a square — the bottom-right pane anchors on the top-right", async () => {
    const { client, calls } = fakeCmux();
    await ensureTriage(client, OPTS);

    const surfaceOf = (c: string[]) => c[c.indexOf("--surface") + 1];
    const splits = calls.filter((c) => verb(["cmux", ...c]) === "new-split");

    expect(splits.map((c) => c[1])).toEqual(["right", "down", "down"]);
    /*
     * THE ANCHORS ARE THE WHOLE TEST, as they are for the operations console.
     *
     *   right off surf-0 — obs-t1 beside the reconciler
     *   down  off surf-0 — obs-t2 under the reconciler   (splitFrom 0)
     *   down  off surf-1 — obs-t3 under obs-t1           (splitFrom 1)
     *
     * The last one is why `splitFrom` exists. Split off its PREDECESSOR — surf-2
     * — the fourth pane stacks a third row in the left column and the console
     * comes out 3+1 while every count, title and direction assertion still
     * passes.
     */
    expect(splits.map(surfaceOf)).toEqual(["surf-0", "surf-0", "surf-1"]);
    // Every pane respawns into the surface it was given, and never twice into
    // one: a stale anchor repeats an id here.
    const respawned = calls
      .filter((c) => verb(["cmux", ...c]) === "respawn-pane")
      .map(surfaceOf);
    expect(respawned).toEqual(["surf-0", "surf-1", "surf-2", "surf-3"]);
  });

  test("the workspace is named `triage` and opened on the INVOCATION directory", async () => {
    const { client, calls } = fakeCmux();
    await ensureTriage(client, OPTS);
    const create = calls.find((c) => verb(["cmux", ...c]) === "workspace create")!;
    // `--name` is what `findWorkspaceByTitle` matches on next time, exactly.
    expect(create[create.indexOf("--name") + 1]).toBe("triage");
    expect(create[create.indexOf("--cwd") + 1]).toBe(CWD);
    // Never steal focus while building; the workspace is selected at the end.
    expect(create[create.indexOf("--focus") + 1]).toBe("false");
  });

  /**
   * `ensureTriage` DRIVES `TRIAGE_SPEC`, and not some other spec that happens to
   * agree with it today.
   *
   * Every probe above would also pass if `ensureTriage` inlined its own literal,
   * or named a spec that is currently identical. Building the same console
   * straight from the exported value and comparing the two call streams is what
   * pins the wiring itself — `TRIAGE_SPEC` is the one edit point, so a future
   * change to it must reach the entry point the driver calls.
   *
   * `slice(1)` drops `ensureTriage`'s own `workspace list`: that is the adoption
   * probe, which `createWorkspace` does not perform and must not.
   */
  test("is the exported spec, not a second copy of it", async () => {
    const viaEnsure = fakeCmux();
    await ensureTriage(viaEnsure.client, OPTS);

    const viaSpec = fakeCmux();
    await createWorkspace(viaSpec.client, TRIAGE_SPEC, OPTS);

    expect(viaEnsure.calls.slice(1)).toEqual(viaSpec.calls);
    // And the spec's name is the title the create actually used, rather than a
    // field nothing reads.
    expect(TRIAGE_SPEC.name).toBe("triage");
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
