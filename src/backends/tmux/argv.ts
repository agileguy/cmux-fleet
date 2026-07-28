/**
 * tmux argv construction and output parsing — pure functions, no server.
 *
 * Everything here was probed against tmux 3.6a at /opt/homebrew/bin/tmux, not
 * read from documentation. The SRD's hard lesson (§18): v1.1 invented protocol
 * messages by reading docs and would have hung on every task. The tmux-shaped
 * version of that failure is quieter — a wrong `-F` format specifier does not
 * error, it expands to an empty string (probed: `#{bogus_no_such_format}` →
 * ""), and an empty string flows onward as a "pane id" until something far
 * away breaks. So every format string used here has a parser that REFUSES
 * output that does not match what the probe showed, and each builder records
 * the probe result that justifies its exact shape.
 *
 * Probe results this file is built on (3.6a, detached server, `-f /dev/null`):
 *  - `new-session -s bad.name` exits 0 and silently creates `bad_name` — tmux
 *    rewrites `.` and `:` to `_`, so an unsanitized name desyncs every later
 *    `-t` target from the session that actually exists.
 *  - `has-session -t w` prefix-matches a session named `w1`; only the `=`
 *    prefix forces exact matching.
 *  - shell-command args: ONE argument is run through a shell (`$((1+1))`
 *    expanded, `;` honored); MULTIPLE arguments are exec'd directly with no
 *    shell at all (an argv element `"with space"` produced a single file with
 *    a space in its name).
 *  - a pane whose process exits within ~1s of spawn loses its output even
 *    with `remain-on-exit on` — the grid is empty, only "Pane is dead"
 *    remains. Viewers are long-running so production is unaffected, but any
 *    TEST asserting on screen content must keep the pane process alive.
 *  - `split-window` at the default 80x24 fails with "no space for new pane"
 *    after 4 splits; at 220x50 with `select-layout tiled` after each split,
 *    8 panes fit comfortably.
 *  - window options set with `set-option -w` do NOT propagate to windows
 *    created later, and the session form `set-option -t =name` fails with
 *    "no such window" for window options — hence window-id (`@N`) targeting.
 *  - `select-window -t %N` accepts a pane id and selects that pane's window.
 *  - `respawn-pane` on a dead pane succeeds, and `-c` sets the cwd relative
 *    paths resolve against.
 */

export interface TmuxContext {
  /**
   * `-L` socket name. Per-run/per-test private sockets keep concurrent fleets
   * (and concurrent test files) off each other's servers — this repo has
   * already been bitten by tests sharing a hashed socket path.
   */
  socketName?: string;
  /**
   * `-f` config file. Tests pass `/dev/null` so a developer's ~/.tmux.conf
   * cannot change behaviour under test; production omits it — the pane is the
   * operator's view, and their config is part of how they view things.
   */
  configFile?: string;
}

/**
 * tmux 3.6a silently rewrites `.` and `:` in session names to `_` (probed
 * above). Silently is the problem: the session that exists is then not the
 * session every later `-t =name` looks for, and each of those fails with
 * "can't find session" against a fleet that is actually running. Normalize
 * before tmux can, so the name we address is the name that exists.
 */
export function sanitizeSessionName(name: string): string {
  const cleaned = name.replace(/[.:\s]/g, "-");
  if (cleaned.length === 0) throw new Error("empty tmux session name");
  return cleaned;
}

/** Prefix every command with the shared server-selection flags. */
export function tmuxArgv(ctx: TmuxContext, cmd: string[]): string[] {
  return [
    "tmux",
    ...(ctx.configFile !== undefined ? ["-f", ctx.configFile] : []),
    ...(ctx.socketName !== undefined ? ["-L", ctx.socketName] : []),
    ...cmd,
  ];
}

/**
 * `=` forces exact session-name matching. Probed: without it, `has-session
 * -t w` matches a session named `w1` — a different run's fleet wearing this
 * one's name.
 */
export function exactSession(name: string): string {
  return `=${name}`;
}

export function versionArgv(ctx: TmuxContext): string[] {
  return tmuxArgv(ctx, ["-V"]);
}

export function hasSessionArgv(ctx: TmuxContext, session: string): string[] {
  return tmuxArgv(ctx, ["has-session", "-t", exactSession(session)]);
}

/**
 * What a pane runs before a viewer attaches. macOS `sleep` rejects
 * `infinity` (probed: "usage: sleep number[unit]"), hence the loop. Kept as
 * an explicit argv rather than a user shell so nobody's rc file runs in it.
 */
export const PLACEHOLDER_ARGV = ["/bin/sh", "-c", "while :; do sleep 3600; done"];

export function newSessionArgv(
  ctx: TmuxContext,
  session: string,
  size: { width: number; height: number },
): string[] {
  // Detached sessions default to 80x24, which runs out of splittable space
  // after 4 panes (probed). -x/-y set a virtual size big enough for a fleet.
  return tmuxArgv(ctx, [
    "new-session",
    "-d",
    "-s",
    session,
    "-x",
    String(size.width),
    "-y",
    String(size.height),
    "--",
    ...PLACEHOLDER_ARGV,
  ]);
}

export function listPanesArgv(ctx: TmuxContext, session: string): string[] {
  // Tab-separated because a pane title is freeish text; a tab inside a title
  // would still break this, but we set every title ourselves (worker ids).
  return tmuxArgv(ctx, [
    "list-panes",
    "-s",
    "-t",
    exactSession(session),
    "-F",
    "#{window_id}\t#{pane_id}\t#{pane_title}\t#{pane_current_command}",
  ]);
}

/**
 * Window options must be set with `-w` on a window target — the session form
 * fails with "no such window" (probed) — and they do not propagate to
 * later-created windows, so the caller pins the one window panes live in by
 * its `@N` id rather than trusting "the current window of the session".
 */
export function setWindowOptionArgv(
  ctx: TmuxContext,
  windowId: string,
  option: string,
  value: string,
): string[] {
  return tmuxArgv(ctx, ["set-option", "-w", "-t", windowId, option, value]);
}

export function splitWindowArgv(ctx: TmuxContext, windowId: string, cwd: string): string[] {
  return tmuxArgv(ctx, [
    "split-window",
    "-d",
    "-t",
    windowId,
    "-c",
    cwd,
    "-P",
    "-F",
    "#{pane_id}",
    "--",
    ...PLACEHOLDER_ARGV,
  ]);
}

export function selectLayoutTiledArgv(ctx: TmuxContext, windowId: string): string[] {
  return tmuxArgv(ctx, ["select-layout", "-t", windowId, "tiled"]);
}

export function setPaneTitleArgv(ctx: TmuxContext, paneId: string, title: string): string[] {
  return tmuxArgv(ctx, ["select-pane", "-t", paneId, "-T", title]);
}

/**
 * Probed semantics on 3.6a: a single shell-command argument runs through a
 * shell; multiple arguments are exec'd directly. A viewer argv must NEVER be
 * shell-interpreted — `pifleet logs --worker x` as one string would survive,
 * but any argument with a metacharacter would not — so a one-element argv is
 * routed through /usr/bin/env to force the multi-argument direct-exec path
 * while keeping PATH lookup.
 */
export function respawnPaneArgv(
  ctx: TmuxContext,
  paneId: string,
  cwd: string | undefined,
  argv: string[],
): string[] {
  const direct = argv.length === 1 ? ["/usr/bin/env", ...argv] : argv;
  return tmuxArgv(ctx, [
    "respawn-pane",
    "-k",
    ...(cwd !== undefined ? ["-c", cwd] : []),
    "-t",
    paneId,
    "--",
    ...direct,
  ]);
}

/** Probed: `select-window -t %N` resolves a pane id to its window. */
export function selectWindowArgv(ctx: TmuxContext, paneId: string): string[] {
  return tmuxArgv(ctx, ["select-window", "-t", paneId]);
}

export function selectPaneArgv(ctx: TmuxContext, paneId: string): string[] {
  return tmuxArgv(ctx, ["select-pane", "-t", paneId]);
}

export function sendKeysLiteralArgv(ctx: TmuxContext, paneId: string, text: string): string[] {
  // `-l` disables key-name lookup so the text arrives as typed; without it
  // a literal string like "Enter" would be translated into a key press.
  return tmuxArgv(ctx, ["send-keys", "-t", paneId, "-l", "--", text]);
}

export function sendKeyArgv(ctx: TmuxContext, paneId: string, key: string): string[] {
  return tmuxArgv(ctx, ["send-keys", "-t", paneId, key]);
}

export function capturePaneArgv(ctx: TmuxContext, paneId: string): string[] {
  return tmuxArgv(ctx, ["capture-pane", "-p", "-t", paneId]);
}

export function killSessionArgv(ctx: TmuxContext, session: string): string[] {
  return tmuxArgv(ctx, ["kill-session", "-t", exactSession(session)]);
}

/**
 * A pane id is `%` + digits, nothing else. The strictness is the guard
 * against tmux's format-string failure mode: an unknown `#{...}` expands to
 * "" rather than erroring (probed), so accepting anything looser would let an
 * empty or mangled id masquerade as a pane ref — and every later `-t` with an
 * empty target silently means "the active pane", which is some pane, never
 * reliably the right one.
 */
export function parsePaneId(stdout: string): string {
  const s = stdout.trim();
  if (!/^%\d+$/.test(s)) {
    throw new Error(`expected a tmux pane id ("%N"), got ${JSON.stringify(stdout)}`);
  }
  return s;
}

export interface PaneListing {
  windowId: string;
  paneId: string;
  title: string;
  currentCommand: string;
}

/** Parse `list-panes` output in the tab-separated shape listPanesArgv requests. */
export function parsePaneList(stdout: string): PaneListing[] {
  const out: PaneListing[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [windowId, paneId, title, currentCommand] = line.split("\t");
    // Window ids are `@` + digits; the same empty-expansion trap as pane ids.
    if (windowId === undefined || !/^@\d+$/.test(windowId)) {
      throw new Error(`unparseable list-panes line (window id): ${JSON.stringify(line)}`);
    }
    if (paneId === undefined || !/^%\d+$/.test(paneId)) {
      throw new Error(`unparseable list-panes line (pane id): ${JSON.stringify(line)}`);
    }
    out.push({ windowId, paneId, title: title ?? "", currentCommand: currentCommand ?? "" });
  }
  return out;
}

/** `tmux -V` → "tmux 3.6a" (probed); anything else is not a tmux we understand. */
export function parseVersion(stdout: string): string | null {
  const m = /^tmux\s+(\S+)/.exec(stdout.trim());
  return m?.[1] ?? null;
}
