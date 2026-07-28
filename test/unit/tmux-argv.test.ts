/**
 * backends/tmux/argv.ts — argv construction and output parsing.
 *
 * Pure-function tests, no tmux server. The parsers matter most: tmux's
 * failure mode for a wrong `-F` format is an empty expansion, not an error
 * (probed on 3.6a), so the tests here pin the exact refusal behaviour that
 * keeps an empty string from ever becoming a "pane id".
 */

import { describe, expect, test } from "bun:test";
import {
  capturePaneArgv,
  exactSession,
  hasSessionArgv,
  killSessionArgv,
  listPanesArgv,
  newSessionArgv,
  parsePaneId,
  parsePaneList,
  parseVersion,
  PLACEHOLDER_ARGV,
  respawnPaneArgv,
  sanitizeSessionName,
  selectLayoutTiledArgv,
  sendKeysLiteralArgv,
  setWindowOptionArgv,
  splitWindowArgv,
  tmuxArgv,
} from "../../src/backends/tmux/argv.ts";

describe("sanitizeSessionName", () => {
  /**
   * tmux 3.6a silently rewrites `.` and `:` to `_` in new-session, so an
   * unsanitized name creates a session every later `=name` target misses.
   */
  test("replaces the characters tmux would rewrite or misparse", () => {
    expect(sanitizeSessionName("pifleet-2026.07.27:run 1")).toBe("pifleet-2026-07-27-run-1");
  });

  test("passes clean names through untouched", () => {
    expect(sanitizeSessionName("pifleet-abc-123")).toBe("pifleet-abc-123");
  });

  test("refuses an empty name rather than addressing nothing", () => {
    expect(() => sanitizeSessionName("")).toThrow(/empty/);
  });
});

describe("tmuxArgv server-selection flags", () => {
  test("config file and socket name both present, in tmux flag order", () => {
    expect(tmuxArgv({ configFile: "/dev/null", socketName: "s1" }, ["-V"])).toEqual([
      "tmux",
      "-f",
      "/dev/null",
      "-L",
      "s1",
      "-V",
    ]);
  });

  test("production shape: no -f, no -L — the operator's server and config", () => {
    expect(tmuxArgv({}, ["kill-server"])).toEqual(["tmux", "kill-server"]);
  });
});

describe("target construction", () => {
  /**
   * Probed: `has-session -t w` matches a session named `w1`. The `=` prefix
   * is what stands between this fleet and another run's fleet with a
   * name-prefix collision.
   */
  test("session targets are exact-match", () => {
    expect(exactSession("w1")).toBe("=w1");
    expect(hasSessionArgv({}, "w1")).toEqual(["tmux", "has-session", "-t", "=w1"]);
    expect(killSessionArgv({}, "w1")).toEqual(["tmux", "kill-session", "-t", "=w1"]);
  });

  test("list-panes is session-scoped and carries window id in its format", () => {
    const argv = listPanesArgv({}, "w1");
    expect(argv).toContain("-s");
    expect(argv[argv.length - 1]).toContain("#{window_id}");
    expect(argv[argv.length - 1]).toContain("#{pane_id}");
  });
});

describe("pane lifecycle argv", () => {
  test("new-session is detached with an explicit virtual size and placeholder argv", () => {
    expect(newSessionArgv({}, "w1", { width: 220, height: 50 })).toEqual([
      "tmux",
      "new-session",
      "-d",
      "-s",
      "w1",
      "-x",
      "220",
      "-y",
      "50",
      "--",
      ...PLACEHOLDER_ARGV,
    ]);
  });

  test("split-window targets the pinned window id, not the session's current window", () => {
    expect(splitWindowArgv({}, "@3", "/tmp/wt")).toEqual([
      "tmux",
      "split-window",
      "-d",
      "-t",
      "@3",
      "-c",
      "/tmp/wt",
      "-P",
      "-F",
      "#{pane_id}",
      "--",
      ...PLACEHOLDER_ARGV,
    ]);
  });

  test("window options use -w on the window id (the session form fails on 3.6a)", () => {
    expect(setWindowOptionArgv({}, "@0", "remain-on-exit", "on")).toEqual([
      "tmux",
      "set-option",
      "-w",
      "-t",
      "@0",
      "remain-on-exit",
      "on",
    ]);
  });

  test("select-layout tiled targets the window id", () => {
    expect(selectLayoutTiledArgv({}, "@0")).toEqual(["tmux", "select-layout", "-t", "@0", "tiled"]);
  });
});

describe("respawnPaneArgv shell-avoidance", () => {
  /**
   * Probed semantics: one shell-command argument runs through a shell,
   * multiple are exec'd directly. The viewer argv must never meet a shell.
   */
  test("multi-argument viewer argv is passed verbatim after --", () => {
    expect(respawnPaneArgv({}, "%5", "/tmp/wt", ["pifleet", "logs", "--worker", "eng-1"])).toEqual([
      "tmux",
      "respawn-pane",
      "-k",
      "-c",
      "/tmp/wt",
      "-t",
      "%5",
      "--",
      "pifleet",
      "logs",
      "--worker",
      "eng-1",
    ]);
  });

  test("single-argument argv is routed through env to force direct exec", () => {
    const argv = respawnPaneArgv({}, "%5", undefined, ["htop"]);
    expect(argv.slice(argv.indexOf("--") + 1)).toEqual(["/usr/bin/env", "htop"]);
  });

  test("cwd flag is omitted when no cwd was recorded", () => {
    expect(respawnPaneArgv({}, "%5", undefined, ["a", "b"])).not.toContain("-c");
  });
});

describe("send-keys literal mode", () => {
  test("uses -l so text like 'Enter' is typed, not translated to a key", () => {
    expect(sendKeysLiteralArgv({}, "%2", "Enter")).toEqual([
      "tmux",
      "send-keys",
      "-t",
      "%2",
      "-l",
      "--",
      "Enter",
    ]);
  });
});

describe("capture-pane (diagnostics only)", () => {
  test("prints to stdout with -p", () => {
    expect(capturePaneArgv({}, "%1")).toEqual(["tmux", "capture-pane", "-p", "-t", "%1"]);
  });
});

describe("parsePaneId", () => {
  test("accepts a pane id with trailing newline", () => {
    expect(parsePaneId("%12\n")).toBe("%12");
  });

  /**
   * The empty string is exactly what a mistyped `-F` format produces (probed:
   * `#{bogus}` → ""). Accepting it would turn every later `-t` into "the
   * active pane".
   */
  test("refuses the empty expansion a wrong format string produces", () => {
    expect(() => parsePaneId("")).toThrow(/pane id/);
    expect(() => parsePaneId("\n")).toThrow(/pane id/);
  });

  test("refuses ids without the % sigil or with trailing junk", () => {
    expect(() => parsePaneId("12")).toThrow(/pane id/);
    expect(() => parsePaneId("%12 extra")).toThrow(/pane id/);
  });
});

describe("parsePaneList", () => {
  test("parses the tab-separated window/pane/title/command shape", () => {
    const out = parsePaneList("@0\t%0\teng-1\tbash\n@0\t%3\teng-2\tsleep\n");
    expect(out).toEqual([
      { windowId: "@0", paneId: "%0", title: "eng-1", currentCommand: "bash" },
      { windowId: "@0", paneId: "%3", title: "eng-2", currentCommand: "sleep" },
    ]);
  });

  test("skips blank lines but refuses malformed ids", () => {
    expect(parsePaneList("\n\n")).toEqual([]);
    expect(() => parsePaneList("\t%0\tt\tc")).toThrow(/window id/);
    expect(() => parsePaneList("@0\t\tt\tc")).toThrow(/pane id/);
  });
});

describe("parseVersion", () => {
  test("extracts the probed 3.6a shape", () => {
    expect(parseVersion("tmux 3.6a\n")).toBe("3.6a");
  });

  test("returns null for anything that is not a tmux banner", () => {
    expect(parseVersion("")).toBeNull();
    expect(parseVersion("bash: tmux: command not found")).toBeNull();
  });
});
