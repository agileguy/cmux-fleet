/**
 * tmux argv construction and output parsing — pure functions, no server.
 *
 * Everything here is verified against tmux 3.6a at /opt/homebrew/bin/tmux, not
 * against documentation. The SRD's hard lesson (§18): v1.1 invented protocol
 * messages by reading docs and would have hung on every task. The tmux-shaped
 * version of that failure is quieter — a wrong `-F` format specifier does not
 * error, it expands to an empty string, and an empty string flows onward as a
 * "pane id" until something far away breaks. So every format string used here
 * has a parser that REFUSES output that does not look like what the probe
 * showed, and the probe results are recorded next to the builder they justify.
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
 * tmux session names may not contain `.` or `:` — both are target-syntax
 * separators (`session:window.pane`), and 3.6a's new-session rejects them
 * outright ("bad session name"). Run ids contain neither after newRunId's own
 * sanitization, but the workspace name is caller-supplied, so we normalize
 * rather than trust.
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
 * `=` forces exact session-name matching. Without it tmux prefix-matches, so
 * a session `pifleet-a` would satisfy `has-session -t pifleet` — a different
 * run's fleet wearing this one's name.
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

/** Placeholder for panes with no viewer attached yet (see index.ts). */
export const PLACEHOLDER_ARGV = ["/bin/sh", "-c", "while :; do sleep 3600; done"];

export function newSessionArgv(
  ctx: TmuxContext,
  session: string,
  size: { width: number; height: number },
): string[] {
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
  return tmuxArgv(ctx, [
    "list-panes",
    "-s",
    "-t",
    exactSession(session),
    "-F",
    "#{pane_id}\t#{pane_title}\t#{pane_current_command}",
  ]);
}

export function splitWindowArgv(ctx: TmuxContext, session: string, cwd: string): string[] {
  return tmuxArgv(ctx, [
    "split-window",
    "-d",
    "-t",
    `${exactSession(session)}:`,
    "-c",
    cwd,
    "-P",
    "-F",
    "#{pane_id}",
    "--",
    ...PLACEHOLDER_ARGV,
  ]);
}

export function selectLayoutTiledArgv(ctx: TmuxContext, session: string): string[] {
  return tmuxArgv(ctx, ["select-layout", "-t", `${exactSession(session)}:`, "tiled"]);
}

export function setPaneTitleArgv(ctx: TmuxContext, paneId: string, title: string): string[] {
  return tmuxArgv(ctx, ["select-pane", "-t", paneId, "-T", title]);
}

export function borderStatusArgv(ctx: TmuxContext, session: string): string[] {
  return tmuxArgv(ctx, [
    "set-option",
    "-t",
    exactSession(session),
    "pane-border-status",
    "top",
  ]);
}

export function respawnPaneArgv(
  ctx: TmuxContext,
  paneId: string,
  cwd: string | undefined,
  argv: string[],
): string[] {
  return tmuxArgv(ctx, [
    "respawn-pane",
    "-k",
    ...(cwd !== undefined ? ["-c", cwd] : []),
    "-t",
    paneId,
    "--",
    ...argv,
  ]);
}

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
 * A pane id is `%` + digits, nothing else. The strictness is the guard against
 * tmux's failure mode for format strings: an unknown `#{...}` expands to ""
 * rather than erroring, so accepting anything looser would let an empty or
 * mangled id masquerade as a pane ref and every later `-t` would target the
 * active pane instead — silently, and only visibly to a human watching.
 */
export function parsePaneId(stdout: string): string {
  const s = stdout.trim();
  if (!/^%\d+$/.test(s)) {
    throw new Error(`expected a tmux pane id ("%N"), got ${JSON.stringify(stdout)}`);
  }
  return s;
}

export interface PaneListing {
  paneId: string;
  title: string;
  currentCommand: string;
}

/** Parse `list-panes` output in the tab-separated shape listPanesArgv requests. */
export function parsePaneList(stdout: string): PaneListing[] {
  const out: PaneListing[] = [];
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    const [paneId, title, currentCommand] = line.split("\t");
    if (paneId === undefined || !/^%\d+$/.test(paneId)) {
      throw new Error(`unparseable list-panes line: ${JSON.stringify(line)}`);
    }
    out.push({ paneId, title: title ?? "", currentCommand: currentCommand ?? "" });
  }
  return out;
}

/** `tmux -V` → "tmux 3.6a"; anything else is not a tmux we understand. */
export function parseVersion(stdout: string): string | null {
  const m = /^tmux\s+(\S+)/.exec(stdout.trim());
  return m?.[1] ?? null;
}
