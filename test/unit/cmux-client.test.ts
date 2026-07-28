/**
 * cmux argv construction and output parsing — pure, no daemon (ISC-129..133).
 *
 * These are the two places this backend can fail silently, and both have
 * precedent in this repo. `network.ts` shipped a parse that read a missing
 * field as a benign default; `harvest/git.ts` shipped a flag in the wrong
 * position, which every unit test survived because they only exercised
 * parsers. So the argv builders are asserted as EXACT arrays — not "contains"
 * — because a flag that moves is a flag that changes meaning, and a
 * `toContain` assertion cannot tell the two apart.
 *
 * The identifier guards get the most attention. cmux takes worker ids, titles
 * and status values that originate in config, and a leading `-` turns any of
 * them into a flag on someone else's command line. Refusing beats sanitizing:
 * a silently mangled title is a lie about what the worker sent.
 */

import { describe, expect, test } from "bun:test";
import {
  assertCmuxText,
  assertCmuxValue,
  capabilitiesArgv,
  focusPaneArgv,
  listPanesArgv,
  newSplitArgv,
  readScreenArgv,
  sendArgv,
  sendKeyArgv,
  setProgressArgv,
  setStatusArgv,
  workspaceCloseArgv,
  workspaceCreateArgv,
  workspaceListArgv,
} from "../../src/backends/cmux/client.ts";
import {
  composePaneId,
  CmuxParseError,
  findWorkspaceByTitle,
  parseAccessMode,
  parseListPanes,
  parseNewSplit,
  parseWorkspaceCreate,
  parseWorkspaceList,
  shellQuote,
  splitPaneId,
} from "../../src/backends/cmux/parse.ts";

describe("identifier and text guards refuse what would change a command line", () => {
  test.each([
    ["", "empty"],
    ["-x", "leading dash parses as a flag"],
    ["a b", "space splits into two argv entries"],
    ["a\nb", "newline"],
    ["a;rm -rf /", "shell metacharacters"],
    ["a\u0000b", "NUL"],
    ["x".repeat(257), "over the length cap"],
  ])("assertCmuxValue refuses %j (%s)", (bad) => {
    expect(() => assertCmuxValue("worker id", bad)).toThrow(/refusing/);
  });

  test.each(["eng-1", "workspace:3", "a.b_c-d", "0abc"])("assertCmuxValue accepts %j", (ok) => {
    expect(() => assertCmuxValue("worker id", ok)).not.toThrow();
  });

  /**
   * Text is deliberately laxer than an identifier — a pane title with spaces
   * is legitimate — but a leading dash and control characters are not, the
   * latter because a worker-authored string reaching a terminal can redraw the
   * operator's screen (SRD §12.6).
   */
  test.each([
    ["", "empty"],
    ["-title", "leading dash"],
    ["a\u001b[2Jb", "ESC — clears the operator's screen"],
    ["a\u0007b", "BEL"],
    ["a\u007fb", "DEL"],
    ["x".repeat(1025), "over the length cap"],
  ])("assertCmuxText refuses %j (%s)", (bad) => {
    expect(() => assertCmuxText("title", bad)).toThrow(/refusing/);
  });

  test.each(["eng-1 building", "a: b (c)", "unicode ✓ ok"])("assertCmuxText accepts %j", (ok) => {
    expect(() => assertCmuxText("title", ok)).not.toThrow();
  });
});

describe("argv builders produce exactly the documented command line", () => {
  // `--id-format uuids` on every read: refs are window-scoped and RENUMBER as
  // workspaces move, so a ref cached across two calls can address a different
  // workspace. Dropping it is silent misaddressing, not an error.
  const IDS = ["--json", "--id-format", "uuids"];

  test("capabilities", () => {
    expect(capabilitiesArgv()).toEqual(["capabilities", "--json"]);
  });

  test("workspace list asks for uuids", () => {
    expect(workspaceListArgv()).toEqual(["workspace", "list", ...IDS]);
  });

  /**
   * `--focus false` matters: `up` creates N workspaces in a loop, and a
   * focusing create would yank the operator's window N times and leave focus
   * wherever the loop happened to end.
   */
  test("workspace create names the workspace and does not steal focus", () => {
    expect(workspaceCreateArgv("pifleet-run")).toEqual([
      "workspace",
      "create",
      "--name",
      "pifleet-run",
      "--focus",
      "false",
      ...IDS,
    ]);
  });

  test("workspace create passes cwd when given", () => {
    expect(workspaceCreateArgv("pifleet-run", "/tmp/repo")).toContain("--cwd");
    expect(workspaceCreateArgv("pifleet-run", "/tmp/repo")).toContain("/tmp/repo");
  });

  test("list-panes is scoped to a workspace", () => {
    expect(listPanesArgv("ws-uuid")).toEqual(["list-panes", "--workspace", "ws-uuid", ...IDS]);
  });

  test("new-split targets a surface inside a workspace and does not steal focus", () => {
    expect(newSplitArgv("ws-uuid", "surf-uuid", "right")).toEqual([
      "new-split",
      "right",
      "--workspace",
      "ws-uuid",
      "--surface",
      "surf-uuid",
      "--focus",
      "false",
      ...IDS,
    ]);
  });

  test("focus-pane addresses a pane, not a surface", () => {
    expect(focusPaneArgv("pane-uuid")).toEqual(["focus-pane", "--pane", "pane-uuid"]);
  });

  test("read-screen addresses a surface", () => {
    expect(readScreenArgv("surf-uuid")).toEqual(["read-screen", "--surface", "surf-uuid"]);
  });

  test("send and send-key address a surface", () => {
    expect(sendArgv("surf-uuid", "hello")).toEqual(["send", "--surface", "surf-uuid", "hello"]);
    expect(sendKeyArgv("surf-uuid", "enter")).toEqual(["send-key", "--surface", "surf-uuid", "enter"]);
  });

  test("set-progress is clamped into cmux's 0..1 domain", () => {
    expect(setProgressArgv("ws", 2)).toContain("1.0000");
    expect(setProgressArgv("ws", -1)).toContain("0.0000");
    expect(setProgressArgv("ws", 0.5)).toContain("0.5000");
  });

  /**
   * The one value the clamp did not contain. `Math.min(1, Math.max(0, NaN))`
   * is `NaN` and `NaN.toFixed(4)` is the string `"NaN"`, so a non-number
   * reached cmux's argv as a progress value — through the very expression
   * written to prevent out-of-domain input.
   *
   * Split out from the test above deliberately: that one pins 2, -1 and 0.5,
   * all finite, so it reads as covering this and does not. Both infinities
   * clamp correctly, which is what makes the gap easy to miss. A division by
   * zero upstream is the whole exploit.
   */
  test("set-progress refuses to emit a non-numeric value", () => {
    expect(setProgressArgv("ws", Number.NaN)).toContain("0.0000");
    expect(setProgressArgv("ws", Number.NaN).join(" ")).not.toContain("NaN");
    // The infinities were already right; pinned so a rewrite keeps them.
    expect(setProgressArgv("ws", Number.POSITIVE_INFINITY)).toContain("1.0000");
    expect(setProgressArgv("ws", Number.NEGATIVE_INFINITY)).toContain("0.0000");
  });

  test("every builder refuses an injected identifier rather than emitting it", () => {
    expect(() => listPanesArgv("--rm")).toThrow(/refusing/);
    expect(() => focusPaneArgv("a b")).toThrow(/refusing/);
    expect(() => workspaceCloseArgv("-x")).toThrow(/refusing/);
    expect(() => setStatusArgv("ws", "-k", "v")).toThrow(/refusing/);
    expect(() => sendArgv("surf", "-oops")).toThrow(/refusing/);
  });
});

describe("output parsing tolerates cmux's two id spellings and refuses nonsense", () => {
  /**
   * With `--id-format uuids` the KEY NAMES change: `workspace_ref` becomes
   * `workspace_id`. A parser written against one spelling reads `undefined`
   * from the other and reports "no workspace" — which sends the caller off to
   * create a duplicate rather than failing.
   */
  test("workspace create parses the uuid spelling", () => {
    const got = parseWorkspaceCreate(
      JSON.stringify({ workspace_id: "w1", surface_id: "s1", window_id: "win1" }),
    );
    expect(got).toEqual({ workspaceId: "w1", surfaceId: "s1", windowId: "win1" });
  });

  test("workspace create parses the ref spelling", () => {
    const got = parseWorkspaceCreate(
      JSON.stringify({ workspace_ref: "workspace:2", surface_ref: "surface:4" }),
    );
    expect(got.workspaceId).toBe("workspace:2");
    expect(got.surfaceId).toBe("surface:4");
    expect(got.windowId).toBeNull();
  });

  test.each([
    ["not json", "not json at all"],
    ["[]", "an array, not an object"],
    ['{"workspace_id":"w1"}', "missing the surface id"],
    ['{"workspace_id":"","surface_id":"s"}', "an empty id"],
  ])("workspace create THROWS on %j (%s)", (raw) => {
    // Throwing, not returning null: a cmux speaking an unexpected dialect must
    // be a loud parse failure, never "workspace not found".
    expect(() => parseWorkspaceCreate(raw)).toThrow(CmuxParseError);
  });

  test("workspace list matches on custom_title only", () => {
    // The decoy is FIRST on purpose. With the match at index 0, any
    // "return the first workspace" bug returns the right answer by accident
    // and the test certifies matching logic it never exercised — the mutation
    // that reduces this function to `list[0]` survived exactly that ordering.
    const list = parseWorkspaceList(
      JSON.stringify({
        workspaces: [
          { id: "w2", title: "pifleet-run" }, // `title` only — a decoy
          { id: "w1", custom_title: "pifleet-run", title: "repo" },
        ],
      }),
    );
    expect(list).toHaveLength(2);
    // `title` falls back to the directory name for unnamed workspaces, so
    // matching it would adopt any workspace whose cwd merely looks like ours.
    const found = findWorkspaceByTitle(list, "pifleet-run");
    expect(found?.id).toBe("w1");
  });

  /**
   * No match must be `null`, never "the first one". Adopting an unrelated
   * workspace is worse than creating a second: `up` would split its panes into
   * whatever the operator happened to have open.
   */
  test("no custom_title match returns null rather than an arbitrary workspace", () => {
    const list = parseWorkspaceList(
      JSON.stringify({ workspaces: [{ id: "w2", title: "something-else" }] }),
    );
    expect(findWorkspaceByTitle(list, "pifleet-run")).toBeNull();
  });

  test("list-panes carries the surface a viewer must address", () => {
    const panes = parseListPanes(
      JSON.stringify({ panes: [{ id: "p1", selected_surface_id: "s1", index: 0 }] }),
    );
    expect(panes).toEqual([{ paneId: "p1", selectedSurfaceId: "s1", index: 0 }]);
  });

  test("new-split parses both spellings", () => {
    expect(parseNewSplit(JSON.stringify({ pane_id: "p", surface_id: "s" }))).toEqual({
      paneId: "p",
      surfaceId: "s",
    });
    expect(parseNewSplit(JSON.stringify({ pane_ref: "pane:1", surface_ref: "surface:2" }))).toEqual({
      paneId: "pane:1",
      surfaceId: "surface:2",
    });
  });

  test("capabilities exposes the access mode and throws without it", () => {
    expect(parseAccessMode(JSON.stringify({ access_mode: "full", methods: [] }))).toBe("full");
    expect(() => parseAccessMode(JSON.stringify({ methods: [] }))).toThrow(CmuxParseError);
  });
});

describe("the composed pane id round-trips and rejects what would corrupt it", () => {
  test("compose then split is the identity", () => {
    const composed = composePaneId("pane-uuid", "surface-uuid");
    expect(splitPaneId(composed)).toEqual({ paneId: "pane-uuid", surfaceId: "surface-uuid" });
  });

  test("an embedded space is refused rather than silently truncating a pane id", () => {
    expect(() => composePaneId("pane uuid", "surface")).toThrow(CmuxParseError);
  });

  test.each(["", "only-one", "a b c", " b", "a "])("splitPaneId refuses %j", (bad) => {
    expect(() => splitPaneId(bad)).toThrow(CmuxParseError);
  });
});

describe("shellQuote makes a config-derived argv inert in a sh script", () => {
  /**
   * The viewer launch line is written to a script because cmux's `--command`
   * text is SHELL-INJECTED — typed into an interactive shell — not exec'd
   * (SRD §4.1). Interpolating a config string into that typed line is command
   * injection by construction.
   */
  test.each([
    ["a; rm -rf /", "command separator"],
    ["$(id)", "command substitution"],
    ["`id`", "backtick substitution"],
    ["a'b", "an embedded single quote — the one character the scheme must splice"],
    ["a b", "a space"],
    ["*", "a glob"],
  ])("neutralizes %j (%s)", async (hostile) => {
    const script = `printf '%s' ${shellQuote([hostile])}`;
    const p = Bun.spawn(["sh", "-c", script], { stdout: "pipe", stderr: "pipe" });
    const out = await new Response(p.stdout).text();
    expect(await p.exited).toBe(0);
    // The shell must hand the string back byte-for-byte: anything else means
    // it was interpreted somewhere along the way.
    expect(out).toBe(hostile);
  });

  test("a multi-word argv survives as separate words", async () => {
    const p = Bun.spawn(["sh", "-c", `printf '%s\\n' ${shellQuote(["a b", "c;d"])}`], {
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(await new Response(p.stdout).text()).toBe("a b\nc;d\n");
  });
});
