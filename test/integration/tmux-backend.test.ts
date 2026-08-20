/**
 * backends/tmux — against a REAL tmux 3.6a server.
 *
 * A private `-L` socket per test file keeps concurrent test runs (and the
 * developer's own tmux) untouched, and `-f /dev/null` keeps ~/.tmux.conf out
 * of the behaviour under test. No TTY anywhere: the server is detached, and
 * every assertion reads through argv + `-F` formats, parsed by the same
 * parsers production uses — so these tests also pin that the real binary
 * still speaks the dialect argv.ts was probed against.
 *
 * One probe finding shapes every screen assertion here: a pane process that
 * exits within ~1s loses its output even with remain-on-exit on. Any command
 * whose output we assert on must therefore stay alive (`...; exec sleep`).
 */

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { realExec } from "../../src/container/run.ts";
import { TmuxBackend } from "../../src/backends/tmux/index.ts";
import {
  hasSessionArgv,
  listPanesArgv,
  parsePaneList,
  tmuxArgv,
} from "../../src/backends/tmux/argv.ts";
import { cliBudget } from "../support/budget.ts";

const SOCKET = `pifleet-it-${process.pid}-${Math.random().toString(36).slice(2, 8)}`;
const CTX = { socketName: SOCKET, configFile: "/dev/null" };

const backend = () => new TmuxBackend({ exec: realExec, ...CTX });

async function panesOf(session: string) {
  const r = await realExec(listPanesArgv(CTX, session));
  expect(r.code).toBe(0);
  return parsePaneList(r.stdout);
}

afterAll(async () => {
  // Unconditional: a failed test must not leave a server squatting on the
  // socket for the next run to trip over.
  await realExec(tmuxArgv(CTX, ["kill-server"]));
});

describe("workspace and pane bring-up", () => {
  test("4 workers → exactly 4 panes, each titled with its worker id, one window", async () => {
    const b = backend();
    const w = await b.ensureWorkspace("it-fleet-a");
    const refs = [];
    for (const id of ["eng-1", "eng-2", "eng-3", "eng-4"]) {
      refs.push(await b.createPane(w, { workerId: id, cwd: "/tmp" }));
    }
    // Distinct, well-formed pane ids — parsePaneId strictness end-to-end.
    expect(new Set(refs.map((r) => r.id)).size).toBe(4);

    const panes = await panesOf("it-fleet-a");
    expect(panes).toHaveLength(4);
    expect(panes.map((p) => p.title).sort()).toEqual(["eng-1", "eng-2", "eng-3", "eng-4"]);
    // One window: the claimed initial pane plus three splits, no stray shell.
    expect(new Set(panes.map((p) => p.windowId)).size).toBe(1);
  }, cliBudget(1));

  test("a session name tmux would silently rewrite is sanitized before tmux sees it", async () => {
    const b = backend();
    // 3.6a rewrites `.`/`:` to `_` on its own; if the backend passed this
    // through, the ref id and the real session name would diverge and this
    // has-session (via the ref id) would fail.
    const w = await b.ensureWorkspace("it.dotty:name");
    expect(w.id).toBe("it-dotty-name");
    const r = await realExec(hasSessionArgv(CTX, w.id ?? ""));
    expect(r.code).toBe(0);
    await b.destroy(w, { keepPanes: false });
  }, cliBudget(1));

  test("ensureWorkspace is idempotent and adoption does not disturb existing panes", async () => {
    const b = backend();
    const w = await b.ensureWorkspace("it-fleet-a");
    expect(w.id).toBe("it-fleet-a");
    expect(await panesOf("it-fleet-a")).toHaveLength(4);
  }, cliBudget(1));

  test("an 8-worker fleet fits: tiled relayout keeps splits from running out of space", async () => {
    const b = backend();
    const w = await b.ensureWorkspace("it-fleet-big");
    for (let i = 1; i <= 8; i++) {
      await b.createPane(w, { workerId: `eng-${i}`, cwd: "/tmp" });
    }
    expect(await panesOf("it-fleet-big")).toHaveLength(8);
    await b.destroy(w, { keepPanes: false });
  }, cliBudget(1));
});

describe("viewers", () => {
  test("attachViewer respawns the pane with the viewer command, in the pane's cwd", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "pifleet-tmux-"));
    const b = backend();
    const w = await b.ensureWorkspace("it-viewer");
    const p = await b.createPane(w, { workerId: "eng-1", cwd });
    // Stays alive on purpose: fast-exit output is lost (probed), so a viewer
    // that printed and quit would assert on an empty grid.
    await b.attachViewer(p, ["/bin/sh", "-c", "printf 'VIEWER-LIVE '; pwd; exec sleep 3600"]);
    await new Promise((r) => setTimeout(r, 400));
    const screen = await b.readScreen(p);
    expect(screen).toContain("VIEWER-LIVE");
    expect(screen).toContain(basename(cwd));
    await b.destroy(w, { keepPanes: false });
  });

  test("a crashed viewer leaves its pane standing (remain-on-exit), not a hole in the layout", async () => {
    const b = backend();
    const w = await b.ensureWorkspace("it-crash");
    const p1 = await b.createPane(w, { workerId: "eng-1", cwd: "/tmp" });
    await b.createPane(w, { workerId: "eng-2", cwd: "/tmp" });
    await b.attachViewer(p1, ["/bin/sh", "-c", "exit 7"]);
    await new Promise((r) => setTimeout(r, 400));
    // The dead pane must still be in the listing: a vanished pane is
    // information destroyed, and the operator's only clue a viewer died.
    expect(await panesOf("it-crash")).toHaveLength(2);
    await b.destroy(w, { keepPanes: false });
  }, cliBudget(1));
});

describe("teardown", () => {
  test("destroy kills the session; destroying an already-gone session is not an error", async () => {
    const b = backend();
    const w = await b.ensureWorkspace("it-fleet-a");
    await b.destroy(w, { keepPanes: false });
    const r = await realExec(hasSessionArgv(CTX, "it-fleet-a"));
    expect(r.code).not.toBe(0);
    // The view is already gone; a second destroy has nothing to do and no
    // reason to fail the caller doing final cleanup.
    await b.destroy(w, { keepPanes: false });
  }, cliBudget(1));

  test("keepPanes leaves the session for post-mortem reading", async () => {
    const b = backend();
    const w = await b.ensureWorkspace("it-keep");
    await b.createPane(w, { workerId: "eng-1", cwd: "/tmp" });
    await b.destroy(w, { keepPanes: true });
    const r = await realExec(hasSessionArgv(CTX, "it-keep"));
    expect(r.code).toBe(0);
    await b.destroy(w, { keepPanes: false });
  }, cliBudget(1));
});
