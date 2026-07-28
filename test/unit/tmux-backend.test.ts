/**
 * backends/tmux/index.ts — the backend's tmux conversation, no server.
 *
 * The exec seam is substituted with a scripted tmux so the *decisions* are
 * testable everywhere: which subcommands run, against which targets, in which
 * order, and how failures are classified. The real 3.6a behaviour those
 * scripts imitate is pinned by test/integration/tmux-backend.test.ts.
 */

import { describe, expect, test } from "bun:test";
import type { Exec, ExecResult } from "../../src/container/run.ts";
import { TmuxBackend } from "../../src/backends/tmux/index.ts";

const ok = (stdout = ""): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });
const fail = (stderr: string): ExecResult => ({ code: 1, stdout: "", stderr, timedOut: false });

/**
 * A scripted tmux server: dispatches on the subcommand after the `-f`/`-L`
 * server-selection flags, records every argv for order/target assertions.
 */
function fakeTmux(handlers: Record<string, (argv: string[]) => ExecResult>) {
  const calls: string[][] = [];
  const exec: Exec = async (argv) => {
    calls.push(argv);
    let i = 1;
    while (argv[i] === "-f" || argv[i] === "-L") i += 2;
    const cmd = argv[i] ?? argv[1] ?? "";
    const h = handlers[cmd];
    return h !== undefined ? h(argv) : fail(`fakeTmux: unhandled ${cmd}`);
  };
  const ran = (cmd: string) => calls.filter((c) => c.includes(cmd));
  return { exec, calls, ran };
}

/** Handlers for a fresh-session bring-up with pane 0 = %0 in window @0. */
function freshSessionHandlers(overrides: Record<string, (argv: string[]) => ExecResult> = {}) {
  let split = 0;
  return {
    "has-session": () => fail("can't find session: w"),
    "new-session": () => ok(),
    "list-panes": () => ok("@0\t%0\tmac\tbash\n"),
    "set-option": () => ok(),
    "split-window": () => ok(`%${++split + 10}\n`),
    "select-layout": () => ok(),
    "select-pane": () => ok(),
    "select-window": () => ok(),
    "respawn-pane": () => ok(),
    "capture-pane": () => ok("screen text\n"),
    "kill-session": () => ok(),
    ...overrides,
  };
}

describe("probe", () => {
  test("reports the parsed version as a required capability", async () => {
    const t = fakeTmux({ "-V": () => ok("tmux 3.6a\n") });
    const caps = await new TmuxBackend({ exec: t.exec }).probe();
    expect(caps).toEqual([{ name: "tmux", ok: true, required: true, detail: "3.6a" }]);
  });

  test("a missing binary is a failed required capability, not a throw", async () => {
    const t = fakeTmux({ "-V": () => fail("command not found") });
    const caps = await new TmuxBackend({ exec: t.exec }).probe();
    expect(caps[0]?.ok).toBe(false);
    expect(caps[0]?.required).toBe(true);
  });
});

describe("ensureWorkspace", () => {
  test("creates a detached, sized session under the sanitized name", async () => {
    const t = fakeTmux(freshSessionHandlers());
    const b = new TmuxBackend({ exec: t.exec, socketName: "s", configFile: "/dev/null" });
    const w = await b.ensureWorkspace("pifleet-2026.07.27:a");
    // The id handed back must be the name tmux actually has — 3.6a silently
    // rewrites `.` and `:`, so passing the raw name through would desync
    // every later target from the real session.
    expect(w).toEqual({ backend: "tmux", id: "pifleet-2026-07-27-a" });
    const ns = t.ran("new-session")[0];
    expect(ns).toBeDefined();
    expect(ns).toContain("-d");
    expect(ns?.join(" ")).toContain("-s pifleet-2026-07-27-a");
  });

  test("pins window options on the window id, for the window panes live in", async () => {
    const t = fakeTmux(freshSessionHandlers());
    await new TmuxBackend({ exec: t.exec }).ensureWorkspace("w");
    const opts = t.ran("set-option").map((c) => c.join(" "));
    expect(opts).toContain("tmux set-option -w -t @0 pane-border-status top");
    expect(opts).toContain("tmux set-option -w -t @0 remain-on-exit on");
  });

  test("an existing session is adopted, never re-created", async () => {
    const t = fakeTmux(
      freshSessionHandlers({
        "has-session": () => ok(),
        "list-panes": () => ok("@4\t%9\teng-1\tsleep\n"),
      }),
    );
    const b = new TmuxBackend({ exec: t.exec });
    const w = await b.ensureWorkspace("w");
    expect(w.id).toBe("w");
    expect(t.ran("new-session")).toHaveLength(0);
    // Adoption must not claim the existing pane %9: it belongs to whoever
    // created it, so the next createPane splits rather than stealing it.
    const p = await b.createPane(w, { workerId: "eng-2", cwd: "/tmp" });
    expect(p.id).not.toBe("%9");
    expect(t.ran("split-window")).toHaveLength(1);
  });
});

describe("createPane", () => {
  test("first pane claims the session's initial pane — N workers, exactly N panes", async () => {
    const t = fakeTmux(freshSessionHandlers());
    const b = new TmuxBackend({ exec: t.exec });
    const w = await b.ensureWorkspace("w");
    const p1 = await b.createPane(w, { workerId: "eng-1", cwd: "/tmp/a" });
    expect(p1).toEqual({ backend: "tmux", id: "%0" });
    expect(t.ran("split-window")).toHaveLength(0);
    // The claimed pane still gets its worker id as title.
    expect(t.ran("select-pane").map((c) => c.join(" "))).toContain(
      "tmux select-pane -t %0 -T eng-1",
    );
  });

  test("later panes split the pinned window and re-tile so the fleet keeps fitting", async () => {
    const t = fakeTmux(freshSessionHandlers());
    const b = new TmuxBackend({ exec: t.exec });
    const w = await b.ensureWorkspace("w");
    await b.createPane(w, { workerId: "eng-1", cwd: "/tmp/a" });
    const p2 = await b.createPane(w, { workerId: "eng-2", cwd: "/tmp/b" });
    expect(p2.id).toBe("%11");
    const split = t.ran("split-window")[0];
    expect(split?.join(" ")).toContain("-t @0");
    expect(split?.join(" ")).toContain("-c /tmp/b");
    expect(t.ran("select-layout").length).toBeGreaterThanOrEqual(1);
  });

  test('"no space for new pane" gets one relayout-then-retry, other errors none', async () => {
    let calls = 0;
    const t = fakeTmux(
      freshSessionHandlers({
        "split-window": () => (++calls === 1 ? fail("no space for new pane") : ok("%7\n")),
      }),
    );
    const b = new TmuxBackend({ exec: t.exec });
    const w = await b.ensureWorkspace("w");
    await b.createPane(w, { workerId: "eng-1", cwd: "/t" });
    const p = await b.createPane(w, { workerId: "eng-2", cwd: "/t" });
    expect(p.id).toBe("%7");
    expect(calls).toBe(2);

    const t2 = fakeTmux(
      freshSessionHandlers({ "split-window": () => fail("lost server") }),
    );
    const b2 = new TmuxBackend({ exec: t2.exec });
    const w2 = await b2.ensureWorkspace("w");
    await b2.createPane(w2, { workerId: "eng-1", cwd: "/t" });
    await expect(b2.createPane(w2, { workerId: "eng-2", cwd: "/t" })).rejects.toThrow(
      /lost server/,
    );
  });

  test("createPane before ensureWorkspace is a refusal, not a guess", async () => {
    const t = fakeTmux(freshSessionHandlers());
    const b = new TmuxBackend({ exec: t.exec });
    await expect(
      b.createPane({ backend: "tmux", id: "w" }, { workerId: "eng-1", cwd: "/t" }),
    ).rejects.toThrow(/ensureWorkspace/);
  });
});

describe("attachViewer", () => {
  test("respawns the pane with the createPane cwd and the argv verbatim", async () => {
    const t = fakeTmux(freshSessionHandlers());
    const b = new TmuxBackend({ exec: t.exec });
    const w = await b.ensureWorkspace("w");
    const p = await b.createPane(w, { workerId: "eng-1", cwd: "/tmp/wt" });
    await b.attachViewer(p, ["pifleet", "logs", "--worker", "eng-1", "--follow"]);
    const r = t.ran("respawn-pane")[0];
    expect(r?.join(" ")).toBe(
      "tmux respawn-pane -k -c /tmp/wt -t %0 -- pifleet logs --worker eng-1 --follow",
    );
  });

  test("an empty viewer argv is refused — tmux would respawn the default shell", async () => {
    const t = fakeTmux(freshSessionHandlers());
    const b = new TmuxBackend({ exec: t.exec });
    const w = await b.ensureWorkspace("w");
    const p = await b.createPane(w, { workerId: "eng-1", cwd: "/t" });
    await expect(b.attachViewer(p, [])).rejects.toThrow(/empty viewer argv/);
  });

  test("a null-id ref (the headless shape) is refused before tmux can guess a target", async () => {
    const t = fakeTmux(freshSessionHandlers());
    const b = new TmuxBackend({ exec: t.exec });
    await expect(b.attachViewer({ backend: "tmux", id: null }, ["x"])).rejects.toThrow(/no id/);
  });
});

describe("focus", () => {
  test("selects the window first, then the pane — a pane id alone cannot raise its window", async () => {
    const t = fakeTmux(freshSessionHandlers());
    const b = new TmuxBackend({ exec: t.exec });
    const w = await b.ensureWorkspace("w");
    const p = await b.createPane(w, { workerId: "eng-1", cwd: "/t" });
    await b.focus(p);
    const order = t.calls.map((c) => c.find((a) => a.startsWith("select-"))).filter(Boolean);
    const wIdx = order.indexOf("select-window");
    const pIdx = order.lastIndexOf("select-pane");
    expect(wIdx).toBeGreaterThanOrEqual(0);
    expect(pIdx).toBeGreaterThan(wIdx);
  });
});

describe("destroy", () => {
  test("keepPanes leaves the view standing for post-mortem reading", async () => {
    const t = fakeTmux(freshSessionHandlers());
    const b = new TmuxBackend({ exec: t.exec });
    const w = await b.ensureWorkspace("w");
    await b.destroy(w, { keepPanes: true });
    expect(t.ran("kill-session")).toHaveLength(0);
  });

  test("otherwise kills the session, tolerating one that is already gone", async () => {
    const t = fakeTmux(
      freshSessionHandlers({ "kill-session": () => fail("can't find session: w") }),
    );
    const b = new TmuxBackend({ exec: t.exec });
    const w = await b.ensureWorkspace("w");
    await b.destroy(w, { keepPanes: false }); // must not throw
    expect(t.ran("kill-session")).toHaveLength(1);
  });

  test("a real kill failure still surfaces", async () => {
    const t = fakeTmux(freshSessionHandlers({ "kill-session": () => fail("server exploded") }));
    const b = new TmuxBackend({ exec: t.exec });
    const w = await b.ensureWorkspace("w");
    await expect(b.destroy(w, { keepPanes: false })).rejects.toThrow(/server exploded/);
  });
});

describe("readScreen stays diagnostics-shaped", () => {
  test("returns raw capture-pane text and nothing structured", async () => {
    const t = fakeTmux(freshSessionHandlers());
    const b = new TmuxBackend({ exec: t.exec });
    const w = await b.ensureWorkspace("w");
    const p = await b.createPane(w, { workerId: "eng-1", cwd: "/t" });
    // A raw string is all a diagnostic needs; anything parseable here would
    // invite a caller to treat rendered text as a control-plane fact.
    expect(await b.readScreen(p)).toBe("screen text\n");
  });
});
