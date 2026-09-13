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

function fakeCmux(
  opts: {
    /** `custom_color` is optional so every existing caller stays byte-identical. */
    workspaces?: Array<{ id: string; custom_title: string | null; custom_color?: string | null }>;
    /** `workspace group list` — omitted means a cmux reporting no groups at all. */
    groups?: Array<{ id: string; name: string }>;
    /**
     * Raw stdout for the group lookup, for the ONE test that needs malformed
     * output: a cmux too old to know the verb answers with an empty string.
     */
    groupsRaw?: string;
  } = {},
): Fake {
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
        case "workspace group":
          // The ONLY way to get malformed output here, and it exists for one
          // test: a cmux too old to know this verb answers with an empty string.
          if (opts.groupsRaw !== undefined) return ok(opts.groupsRaw);
          // Otherwise valid JSON naming no groups — NOT that empty string. The
          // throw path is covered deliberately below, so it must never be the
          // accidental default every other test here runs through.
          return ok(JSON.stringify({ groups: opts.groups ?? [] }));
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
      // A rebuilt console goes back into its sidebar group, so `ensureWorkspace`
      // asks which groups exist. This fake reports none, so no
      // `workspace-group add` follows it — the LOOKUP is what is pinned here,
      // and the adding is pinned where a group actually exists.
      "workspace group",
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
    // …in the workspace just CREATED. Without `--workspace`, cmux resolves the
    // pane against `$CMUX_WORKSPACE_ID` — the workspace of whatever shell ran
    // the script — and a rebuild launched from inside another console died here.
    expect(focus!.indexOf("--workspace"), "focus-pane carries no workspace").toBeGreaterThan(-1);
    expect(focus![focus!.indexOf("--workspace") + 1]).toBe("ws-new");
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
 * **INVERTED 2026-09-13, and the mechanism is unchanged.** This console used to
 * be the one with NO layout correction: `topFraction: null` made
 * `applyTopFraction` return before it read geometry, so triage issued exactly
 * ONE `list-panes` where operations issued two — and that count, not a constant
 * read back, was how the fraction was pinned.
 *
 * It is now a console with the MOST correction: `topFraction` is `1/3` and it
 * carries a `bottomWidthFraction`, because a collator over three observers is a
 * layout `new-split` cannot produce — halving gives 50/50 vertically and
 * 50/25/25 horizontally. So it issues THREE `list-panes`: the focus lookup, the
 * height pass, and the width pass. The probe is the same behavioural one,
 * counting up instead of down — a spec that dropped either fraction reddens
 * here.
 *
 * **"THE ONLY SPEC WITH A `bottomWidthFraction`" LASTED ONE DAY.** This docblock
 * said that until 2026-09-13, when `review` was asked to take the same shape and
 * became the second. Nothing here reddened, because a uniqueness claim about
 * OTHER specs is not a property of the console under test — the same expiry
 * `triagePanes`' own docblock now warns about at greater length. The verb counts
 * below are unaffected: they are assertions about the calls THIS spec makes.
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

  test("issues one create, three splits and four respawns — and THREE list-panes", async () => {
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
      // THREE `list-panes`, and each one is a different claim about this spec.
      // The first is the focus lookup, which every console does. The second is
      // `applyTopFraction` reading geometry — it returns before that read when
      // `topFraction` is `null`, so its presence IS the 1/3 asserted through
      // behaviour. The third is `applyBottomWidths`, which only this console
      // reaches, because it is the only spec carrying a `bottomWidthFraction`.
      //
      // No `resize-pane` follows any of them: this fake reports no
      // `container_frame`, so both passes take their parse-failed path. The
      // calls being ISSUED is what this pins — the arithmetic has no double to
      // run against and is measured on the live console instead.
      "list-panes",
      "focus-pane",
      "list-panes",
      "list-panes",
      // The group lookup every rebuild does. No `workspace-group add` follows:
      // this fake reports no groups.
      "workspace group",
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

  test("the observer row splits DOWN off the collator, and each pane respawns once", async () => {
    const { client, calls } = fakeCmux();
    await ensureTriage(client, OPTS);

    const surfaceOf = (c: string[]) => c[c.indexOf("--surface") + 1];
    const splits = calls.filter((c) => verb(["cmux", ...c]) === "new-split");

    /*
     * **THE FIRST SPLIT IS THE LOAD-BEARING ASSERTION** as of 2026-09-13, and
     * the previous version of this comment named a different pane for the same
     * structural reason — worth keeping, because the lesson outlived its shape.
     * It said pane 4's anchor was the one that mattered, since the 2x2 needed
     * `down` off `surf-1` rather than off its predecessor, and a wrong anchor
     * produced a 3+1 console every other assertion in this file accepted.
     *
     * The shape is now a collator over a row, and the fragile anchor has moved
     * to the FRONT: pane 2 splits `down` off `surf-0`, which is what creates the
     * observer row and leaves `tri-1` spanning the width. Make it `right` — the
     * square builder's table — and the console comes out a 2x2 with the collator
     * in a quarter, while every count, title and command assertion here still
     * passes. Only the direction list catches it.
     *
     * Panes 3 and 4 then walk ALONG that row, each anchored on its predecessor:
     * `surf-1` then `surf-2`. That is the one part that got simpler — a row is
     * the shape where "the previous pane" is finally the right anchor, so the
     * surface list is now consecutive rather than doubling back.
     */
    expect(splits.map((c) => c[1])).toEqual(["down", "right", "right"]);
    expect(splits.map(surfaceOf)).toEqual(["surf-0", "surf-1", "surf-2"]);
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

    /*
     * `ensureTriage` BRACKETS the build with two calls `createWorkspace` does
     * not make: the adoption probe at the front (already dropped by `slice(1)`)
     * and the group/colour restore at the back. Both belong to
     * `ensureWorkspace` — REPLACING a console is what needs them, CONSTRUCTING
     * one does not — so both ends are dropped rather than the comparison being
     * loosened into something that would stop catching a second copy of the spec.
     */
    const PRESENTATION = new Set(["workspace group", "workspace-group", "workspace-action"]);
    const construction = (cs: string[][]): string[][] =>
      cs.filter((c) => !PRESENTATION.has(verb(["cmux", ...c])));
    expect(construction(viaEnsure.calls.slice(1))).toEqual(construction(viaSpec.calls));
    // And the spec's name is the title the create actually used, rather than a
    // field nothing reads.
    expect(TRIAGE_SPEC.name).toBe("triage");
  });
});

/**
 * Closing a workspace takes its sidebar group and its colour with it, and the
 * rebuilt console is a DIFFERENT workspace that cmux has no reason to decorate.
 * So `--recreate` used to return a console sitting outside `pi-fleet` wearing no
 * colour, every time — a small fault, but one the operator had to repair by hand
 * on every rebuild.
 *
 * The colour has to be read BEFORE the old workspace is closed, because after
 * that there is nothing left to read it from. That is why this belongs to
 * `ensureWorkspace` and not to `createWorkspace`, and why the test above that
 * compares their two call streams has to drop this from the comparison.
 */
describe("a rebuilt console goes back into its group wearing its colour", () => {
  const OLD_TRIAGE = { id: "ws-old", custom_title: "triage", custom_color: "#7D6608" };

  test("--recreate adds the new workspace to pi-fleet and re-applies the old colour", async () => {
    const { client, calls } = fakeCmux({
      workspaces: [OLD_TRIAGE],
      groups: [
        // The decoy is FIRST on purpose: with `pi-fleet` at index 0, a "use the
        // only group" or "use the first group" bug passes by accident.
        { id: "workspace_group:2", name: "daily" },
        { id: "workspace_group:1", name: "pi-fleet" },
      ],
    });

    await ensureTriage(client, OPTS, true);

    const add = calls.find((c) => verb(["cmux", ...c]) === "workspace-group");
    expect(add, "the rebuilt console was never added to any group").toBeDefined();
    expect(add![add!.indexOf("--group") + 1]).toBe("workspace_group:1");
    // The NEW workspace, never the one that is about to be closed.
    expect(add![add!.indexOf("--workspace") + 1]).toBe("ws-new");

    const colored = calls.find((c) => verb(["cmux", ...c]) === "workspace-action");
    expect(colored, "the rebuilt console lost its colour").toBeDefined();
    expect(colored![colored!.indexOf("--color") + 1]).toBe("#7D6608");
    expect(colored![colored!.indexOf("--workspace") + 1]).toBe("ws-new");
  });

  /**
   * ORDER, not merely presence. The close is the step with a known failure mode
   * — a pinned workspace refuses it — and if it does fail, the rebuilt console
   * should already be decorated rather than stranded outside its group.
   */
  test("both restorations happen BEFORE the old workspace is closed", async () => {
    const { client, calls } = fakeCmux({
      workspaces: [OLD_TRIAGE],
      groups: [{ id: "workspace_group:1", name: "pi-fleet" }],
    });

    await ensureTriage(client, OPTS, true);

    const verbs = verbsOf(calls);
    expect(verbs).toContain("workspace close");
    expect(verbs.indexOf("workspace-group")).toBeLessThan(verbs.indexOf("workspace close"));
    expect(verbs.indexOf("workspace-action")).toBeLessThan(verbs.indexOf("workspace close"));
  });

  /** A console that never had a colour must not ACQUIRE one from a rebuild. */
  test("a console with no colour is rebuilt without one", async () => {
    const { client, calls } = fakeCmux({
      workspaces: [{ id: "ws-old", custom_title: "triage", custom_color: null }],
      groups: [{ id: "workspace_group:1", name: "pi-fleet" }],
    });

    await ensureTriage(client, OPTS, true);

    expect(verbsOf(calls)).not.toContain("workspace-action");
  });

  /** A group that does not exist is not an error — nothing is added. */
  test("no pi-fleet group means no add, and no refusal", async () => {
    const { client, calls } = fakeCmux({
      workspaces: [OLD_TRIAGE],
      groups: [{ id: "workspace_group:2", name: "daily" }],
    });

    const result = await ensureTriage(client, OPTS, true);

    expect(result).toEqual({ created: true, workspaceId: "ws-new" });
    expect(verbsOf(calls)).not.toContain("workspace-group");
    // The colour is a separate repair and still happens.
    expect(verbsOf(calls)).toContain("workspace-action");
  });

  /**
   * THE REBUILD OUTRANKS ITS DECORATION, and this is the test that pins it.
   *
   * A cmux too old to know `workspace group` answers the lookup with an empty
   * string, which `parseWorkspaceGroupList` THROWS on — deliberately, because
   * that strictness is right for every other caller. Here the throw must not
   * escape: the console has already been built by the time it happens, and a
   * rebuild lost to a sidebar detail is precisely the outage `--recreate`
   * exists to repair. Delete the `catch` in `restoreWorkspacePresentation` and
   * this reddens.
   */
  test("a cmux that cannot answer the group lookup still rebuilds the console", async () => {
    const { client, calls } = fakeCmux({ workspaces: [OLD_TRIAGE], groupsRaw: "" });

    const result = await ensureTriage(client, OPTS, true);

    expect(result).toEqual({ created: true, workspaceId: "ws-new" });
    // And the old console is still closed — the rebuild ran to completion.
    expect(verbsOf(calls)).toContain("workspace close");
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
