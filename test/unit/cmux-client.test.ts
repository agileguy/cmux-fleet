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
  renameTabArgv,
  respawnPaneArgv,
  sendArgv,
  sendKeyArgv,
  setProgressArgv,
  setStatusArgv,
  workspaceCloseArgv,
  workspaceCreateArgv,
  workspaceGroupAddArgv,
  workspaceGroupListArgv,
  workspaceListArgv,
  workspaceSetColorArgv,
} from "../../src/backends/cmux/client.ts";
import {
  composePaneId,
  CmuxParseError,
  findWorkspaceByTitle,
  findWorkspaceGroupByName,
  parseAccessMode,
  parseListPanes,
  parseNewSplit,
  parseWorkspaceCreate,
  parseWorkspaceGroupList,
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

  /**
   * The ONLY verb that prints a group's NAME. `workspace list` reports the
   * group's anchor workspace instead — `Group 1` where the sidebar says
   * `pi-fleet`, probed live 2026-09-13 — so a rebuild resolving the name
   * against that listing finds nothing and leaves every console ungrouped
   * while looking like it worked.
   */
  test("workspace group list asks for uuids", () => {
    expect(workspaceGroupListArgv()).toEqual(["workspace", "group", "list", ...IDS]);
  });

  /**
   * HYPHENATED at the top level. `workspace group <sub>` dispatches to the same
   * place, but cmux documents these flags only under `workspace-group`.
   */
  test("workspace-group add names both the group and the workspace", () => {
    expect(workspaceGroupAddArgv("workspace_group:1", "ws-uuid")).toEqual([
      "workspace-group",
      "add",
      "--group",
      "workspace_group:1",
      "--workspace",
      "ws-uuid",
    ]);
  });

  test("set-color carries the hex and the workspace", () => {
    expect(workspaceSetColorArgv("ws-uuid", "#7D6608")).toEqual([
      "workspace-action",
      "--action",
      "set-color",
      "--color",
      "#7D6608",
      "--workspace",
      "ws-uuid",
    ]);
  });

  /**
   * HEX ONLY, though `set-color` also accepts sixteen colour NAMES. The only
   * value this is ever handed is one cmux itself reported as `custom_color`,
   * and that is always `#rrggbb`; accepting names would widen the surface to a
   * spelling nothing in this repository produces.
   *
   * `assertCmuxValue` would refuse the leading `#` outright — it is not in
   * `CMUX_VALUE_RE` — so what guards this value is the TEXT check plus the
   * pattern, which is why a bad colour must still be refused rather than
   * reaching the command line.
   */
  test.each(["Amber", "#7D660", "#GGGGGG", "", "-#7D6608"])("set-color refuses %j", (bad) => {
    expect(() => workspaceSetColorArgv("ws-uuid", bad)).toThrow(/refusing/);
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
    // `--` before the text is load-bearing, not cosmetic: measured against cmux
    // 0.64.22, `cmux send --surface <id> "--json"` answers `Error: send
    // requires text` and exit 1 with nothing reaching the pane, while the same
    // call with `--` delivers `--json` verbatim. See `assertCmuxSendText`.
    expect(sendArgv("surf-uuid", "hello")).toEqual([
      "send",
      "--surface",
      "surf-uuid",
      "--",
      "hello",
    ]);
    expect(sendKeyArgv("surf-uuid", "enter")).toEqual(["send-key", "--surface", "surf-uuid", "enter"]);
  });

  /**
   * The leading-dash rule this REPLACES, and why the replacement is stronger.
   *
   * `sendArgv` used to refuse any text beginning with `-`, which is the rule
   * `assertCmuxText` still applies to titles, statuses and notification bodies.
   * For `send` it was both too weak and too strong, measured live against cmux
   * 0.64.22 on 2026-08-31 (each arm a fresh pane running `read -r`):
   *
   *   `cmux send --surface <id> "--json"`     -> `Error: send requires text`,
   *                                              exit 1, pane received NOTHING
   *   `cmux send --surface <id> -- "--json"`  -> pane received `--json`, exit 0
   *   `cmux send --surface <id> -- "plain"`   -> pane received `plain`, exit 0
   *
   * So the hazard the old assertion named is real (arm 1), and `--` — cmux's
   * own documented separator, `Usage: cmux send [flags] [--] <text>` — removes
   * it by construction rather than by refusal. The refusal had to go because a
   * prompt typed into a pane is markdown: under the old rule every task with
   * `acceptance` entries refused on its first `- item` line, which is a route
   * that cannot be used.
   *
   * Both directions are asserted here: a leading dash now RIDES (after `--`),
   * and the guards that remain still bite.
   */
  test("send text rides after -- instead of being refused for a leading dash", () => {
    expect(sendArgv("surf", "-oops")).toEqual(["send", "--surface", "surf", "--", "-oops"]);
    expect(sendArgv("surf", "- an acceptance bullet")).toEqual([
      "send",
      "--surface",
      "surf",
      "--",
      "- an acceptance bullet",
    ]);
    // …and the surface id is still an identifier, so the OTHER half of the
    // injection guard is untouched.
    expect(() => sendArgv("-x", "hello")).toThrow(/refusing/);
  });

  test("send text refuses what cmux would silently reinterpret", () => {
    // The two-character escape sequences cmux converts to key events. Measured
    // against the real Pi TUI: `A\nB` submits `A` as a turn and leaves `B` in
    // the prompt box, with every exit code 0.
    expect(() => sendArgv("surf", "first line\\nsecond line")).toThrow(/Enter/);
    expect(() => sendArgv("surf", "a\\rb")).toThrow(/Enter/);
    expect(() => sendArgv("surf", "a\\tb")).toThrow(/Tab/);
    // A real newline byte was already refused as a control character, and stays
    // refused — the escape rule is an ADDITION, not a substitution.
    expect(() => sendArgv("surf", "a\nb")).toThrow(/control characters/);
    expect(() => sendArgv("surf", "")).toThrow(/refusing/);
    expect(() => sendArgv("surf", "x".repeat(1025))).toThrow(/refusing/);
    /**
     * A backslash before ANY OTHER letter is not an escape cmux acts on
     * (measured: argv text `A\xB` arrives at the pane literally), so it must
     * still pass — a guard wider than its evidence would refuse ordinary prose.
     *
     * The first draft of this case used a Windows path, `C:\path\to\file`, on
     * the assumption that it was an innocent backslash example. It is not: `\t`
     * sits inside `\to`, so the guard fired and caught the test's own premise.
     * Left recorded because it is the strongest argument FOR the guard — the
     * sequence does not have to be written deliberately to be there.
     */
    expect(() => sendArgv("surf", "the \\x escape is not one cmux acts on")).not.toThrow();
  });

  /**
   * Unlike `read-screen`/`send`/`send-key`, these two need `--workspace`
   * ahead of `--surface` — cmux 0.64.22 fails to resolve an otherwise-valid
   * surface id for `respawn-pane`/`rename-tab` without it (probed live
   * 2026-08-18; the earlier ref-vs-UUID theory in this project's ISA.md was
   * wrong — see `respawnPaneArgv`'s own comment).
   */
  test("respawn-pane and rename-tab address a surface scoped to its workspace", () => {
    expect(respawnPaneArgv("ws-uuid", "surf-uuid", "sh /tmp/viewer.sh")).toEqual([
      "respawn-pane",
      "--workspace",
      "ws-uuid",
      "--surface",
      "surf-uuid",
      "--command",
      "sh /tmp/viewer.sh",
    ]);
    expect(renameTabArgv("ws-uuid", "surf-uuid", "eng-1")).toEqual([
      "rename-tab",
      "--workspace",
      "ws-uuid",
      "--surface",
      "surf-uuid",
      "--title",
      "eng-1",
    ]);
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
    // `sendArgv`'s TEXT is no longer part of this sweep — it rides after `--`
    // (see "send text rides after -- …" above, which pins both directions).
    // Its identifier half still is.
    expect(() => sendArgv("-x", "hello")).toThrow(/refusing/);
    expect(() => respawnPaneArgv("-x", "surf", "cmd")).toThrow(/refusing/);
    expect(() => respawnPaneArgv("ws", "-x", "cmd")).toThrow(/refusing/);
    expect(() => renameTabArgv("-x", "surf", "title")).toThrow(/refusing/);
    expect(() => renameTabArgv("ws", "-x", "title")).toThrow(/refusing/);
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

  /**
   * `custom_color` is read so `--recreate` can put a console's colour back, and
   * the absent case has to be `null` rather than `""` — a blank would reach the
   * rebuild as `--color ""`.
   */
  test("workspace list carries custom_color, and absence is null", () => {
    const list = parseWorkspaceList(
      JSON.stringify({
        workspaces: [
          { id: "w1", custom_title: "triage", custom_color: "#7D6608" },
          { id: "w2", custom_title: "review" },
          { id: "w3", custom_title: "operations", custom_color: "" },
        ],
      }),
    );
    expect(list.map((w) => w.customColor)).toEqual(["#7D6608", null, null]);
  });

  /**
   * A GROUP IS NOT A WORKSPACE, and this is the distinction the separate parser
   * exists for. A group owns an anchor workspace, and the anchor is what
   * `workspace list` reports — so the sidebar's `pi-fleet` shows up there as its
   * anchor's `custom_title`, `Group 1`. Probed live 2026-09-13. Matching the
   * name against the workspace listing therefore finds nothing at all.
   */
  test("workspace group list parses the groups array by NAME", () => {
    const groups = parseWorkspaceGroupList(
      JSON.stringify({
        groups: [
          { ref: "workspace_group:2", name: "daily" },
          { ref: "workspace_group:1", name: "pi-fleet" },
        ],
      }),
    );
    // The decoy is FIRST: a "return the first group" bug would answer `daily`.
    expect(findWorkspaceGroupByName(groups, "pi-fleet")?.id).toBe("workspace_group:1");
    expect(findWorkspaceGroupByName(groups, "no-such-group")).toBeNull();
  });

  test("workspace group list parses the uuid spelling too", () => {
    const groups = parseWorkspaceGroupList(
      JSON.stringify({ groups: [{ id: "A812DFFA-2542-4642-8BFB-C680134DC6EB", name: "pi-fleet" }] }),
    );
    expect(findWorkspaceGroupByName(groups, "pi-fleet")?.id).toBe(
      "A812DFFA-2542-4642-8BFB-C680134DC6EB",
    );
  });

  /**
   * A cmux too old to know `workspace group` answers with an empty string. The
   * parser THROWS on it, in line with this file's whole doctrine — and
   * `restoreWorkspacePresentation` catches it, so the rebuild survives. Both
   * halves matter: strict here, forgiving at the one call site that has decided
   * a sidebar detail is not worth an outage.
   */
  test.each([
    ["", "an older cmux that does not know the verb"],
    ["not json", "an unexpected dialect"],
    ['{"workspaces":[]}', "the workspace listing, not the group listing"],
  ])("workspace group list THROWS on %j (%s)", (raw) => {
    expect(() => parseWorkspaceGroupList(raw)).toThrow(CmuxParseError);
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
    const composed = composePaneId("pane-uuid", "surface-uuid", "ws-uuid");
    expect(splitPaneId(composed)).toEqual({
      paneId: "pane-uuid",
      surfaceId: "surface-uuid",
      workspaceId: "ws-uuid",
    });
  });

  /**
   * A 2-part id is the pre-`--workspace`-fix encoding, still on disk in any
   * `presentation.json` written by an earlier pifleet build. `splitPaneId`
   * must keep accepting it — `paneId`/`surfaceId` alone are all `focus`,
   * `sendText`, `sendKey` and `readScreen` ever needed — with `workspaceId`
   * reported as `null` rather than a fabricated value, so `attachViewer` can
   * name the real condition instead of throwing an opaque parse error two
   * layers down.
   */
  test("a legacy 2-part id (pre-workspace-fix) still splits, with a null workspaceId", () => {
    expect(splitPaneId("pane-uuid surface-uuid")).toEqual({
      paneId: "pane-uuid",
      surfaceId: "surface-uuid",
      workspaceId: null,
    });
  });

  test("an embedded space is refused rather than silently truncating a pane id", () => {
    expect(() => composePaneId("pane uuid", "surface", "ws")).toThrow(CmuxParseError);
    expect(() => composePaneId("pane", "surface uuid", "ws")).toThrow(CmuxParseError);
    expect(() => composePaneId("pane", "surface", "ws id")).toThrow(CmuxParseError);
  });

  test("an empty field is refused, not silently composed into an id splitPaneId then rejects", () => {
    expect(() => composePaneId("", "surface", "ws")).toThrow(CmuxParseError);
    expect(() => composePaneId("pane", "", "ws")).toThrow(CmuxParseError);
    expect(() => composePaneId("pane", "surface", "")).toThrow(CmuxParseError);
  });

  /**
   * A ONE-part id is a bare surface, and this test used to assert the
   * opposite.
   *
   * `"only-one"` sat in the refusal list below and pinned the defect in
   * place: `up --attach-here` adopts `CMUX_SURFACE_ENV`, which cmux sets to a
   * surface UUID alone, so every console built that way produced exactly this
   * shape — and `sendText`, which wants only a surface, threw on the parse
   * before it could type. That is why no staged dispatch to a `tui` worker
   * ever auto-triggered on such a console. Measured 2026-09-04 in run
   * `2026-09-04T02-28-00Z-e07e`.
   */
  test("a bare surface id splits, with a null paneId and workspaceId", () => {
    expect(splitPaneId("surface-uuid")).toEqual({
      paneId: null,
      surfaceId: "surface-uuid",
      workspaceId: null,
    });
  });

  test("composePaneId's output still round-trips, so widening did not blur the 3-part form", () => {
    // The widening must not make a full id parse as something looser.
    expect(splitPaneId(composePaneId("p", "s", "w"))).toEqual({
      paneId: "p",
      surfaceId: "s",
      workspaceId: "w",
    });
  });

  test.each(["", "a b c d", " b c", "a  c", "a b ", " b", "a ", " "])(
    "splitPaneId refuses %j",
    (bad) => {
      // Empty and over-long are still refused; only the 1-part case moved.
      expect(() => splitPaneId(bad)).toThrow(CmuxParseError);
    },
  );
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
