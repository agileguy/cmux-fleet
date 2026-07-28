/**
 * The cmux CLI client — argv construction and invocation.
 *
 * Binds to the CLI, never to socket method names: cmux commits to CLI
 * stability ("legacy forms keep working indefinitely") and makes no such
 * promise for its RPC surface — 4 of the 18 method names an earlier design
 * relied on do not exist as socket methods while the CLI commands work
 * (SRD §4.1). Every verb here was probed against the installed 0.64.20.
 *
 * Argv builders are exported pure so the unit suite can pin them byte-for-byte
 * without a cmux running — the same discipline as `security/network.ts`, and
 * for the same reason: the flag IS the behaviour. `--json --id-format uuids`
 * on a read verb is not cosmetic; without them the output is `OK workspace:6`
 * prose or window-scoped refs that renumber, and the parser reads garbage.
 */

import { realExec, type Exec, type ExecResult } from "../../container/run.ts";

/**
 * Identifiers that ride the cmux command line as VALUES. cmux parses argv
 * itself, so a config-derived string beginning with `-` would be read as a
 * flag — the same flag-injection hazard `security/network.ts` guards its
 * network name against. UUIDs, refs (`workspace:3`) and status keys all fit
 * this grammar; anything else could not have come from cmux or from a
 * validated config.
 */
const CMUX_VALUE_RE = /^[A-Za-z0-9][A-Za-z0-9:._-]*$/;
const MAX_VALUE = 256;

export function assertCmuxValue(what: string, v: string): void {
  if (v.length === 0 || v.length > MAX_VALUE || !CMUX_VALUE_RE.test(v)) {
    throw new Error(`cmux: refusing ${what} ${JSON.stringify(v.slice(0, 64))} — not a valid cmux identifier`);
  }
}

/**
 * Free text (titles, status values, notification bodies) may contain spaces,
 * but a leading `-` still parses as a flag, and control characters would let a
 * worker-authored string redraw the operator's terminal (SRD §12.6). Refusing
 * beats sanitizing: a mangled title silently displayed is a lie about what the
 * worker sent.
 */
export function assertCmuxText(what: string, v: string): void {
  if (v.length === 0 || v.length > 1024 || v.startsWith("-") || /[\x00-\x1f\x7f]/.test(v)) {
    throw new Error(`cmux: refusing ${what} ${JSON.stringify(v.slice(0, 64))} — leading dash or control characters`);
  }
}

// ---------------------------------------------------------------------------
// Pure argv builders. `bin` is prepended at spawn time, not here, so these
// arrays are directly comparable in tests regardless of where cmux lives.
// ---------------------------------------------------------------------------

/** UUIDs are the only identifier cmux resolves globally; refs are window-scoped and renumber. */
const JSON_IDS = ["--json", "--id-format", "uuids"] as const;

export function pingArgv(): string[] {
  return ["ping"];
}

export function versionArgv(): string[] {
  return ["--version"];
}

export function helpArgv(): string[] {
  return ["--help"];
}

export function capabilitiesArgv(): string[] {
  return ["capabilities", "--json"];
}

export function workspaceListArgv(): string[] {
  return ["workspace", "list", ...JSON_IDS];
}

export function workspaceCreateArgv(name: string, cwd?: string): string[] {
  assertCmuxText("workspace name", name);
  // `--focus false`: a fleet coming up must not steal the operator's focus N
  // times. Note `workspace create` takes `--focus <bool>` and REJECTS
  // `--no-focus` — the flag surface is not uniform across verbs (SRD §4.1).
  const argv = ["workspace", "create", "--name", name, "--focus", "false", ...JSON_IDS];
  if (cwd !== undefined) argv.push("--cwd", cwd);
  return argv;
}

export function workspaceCloseArgv(workspaceId: string): string[] {
  assertCmuxValue("workspace id", workspaceId);
  // Positional, not `--workspace` — probed: `workspace close <workspace>`.
  return ["workspace", "close", workspaceId];
}

export function listPanesArgv(workspaceId: string): string[] {
  assertCmuxValue("workspace id", workspaceId);
  // `--json` is accepted here despite not appearing in `list-panes --help`
  // (probed live); without it the output is a text art listing.
  return ["list-panes", "--workspace", workspaceId, ...JSON_IDS];
}

export type SplitDirection = "right" | "down" | "left" | "up";

export function newSplitArgv(workspaceId: string, surfaceId: string, dir: SplitDirection): string[] {
  assertCmuxValue("workspace id", workspaceId);
  assertCmuxValue("surface id", surfaceId);
  return ["new-split", dir, "--workspace", workspaceId, "--surface", surfaceId, "--focus", "false", ...JSON_IDS];
}

export function focusPaneArgv(paneId: string): string[] {
  assertCmuxValue("pane id", paneId);
  return ["focus-pane", "--pane", paneId];
}

export function renameTabArgv(surfaceId: string, title: string): string[] {
  assertCmuxValue("surface id", surfaceId);
  assertCmuxText("tab title", title);
  // `--title` keeps the text out of positional position (probed form).
  return ["rename-tab", "--surface", surfaceId, "--title", title];
}

export function respawnPaneArgv(surfaceId: string, command: string): string[] {
  assertCmuxValue("surface id", surfaceId);
  return ["respawn-pane", "--surface", surfaceId, "--command", command];
}

export function setStatusArgv(
  workspaceId: string,
  key: string,
  value: string,
  opts?: { icon?: string; color?: string; priority?: number },
): string[] {
  assertCmuxValue("workspace id", workspaceId);
  // Key and value are POSITIONAL on set-status; the identifier grammar for the
  // key and the text guard for the value are what keep them from parsing as flags.
  assertCmuxValue("status key", key);
  assertCmuxText("status value", value);
  const argv = ["set-status", key, value, "--workspace", workspaceId];
  if (opts?.icon !== undefined) {
    assertCmuxValue("status icon", opts.icon);
    argv.push("--icon", opts.icon);
  }
  if (opts?.color !== undefined) {
    if (!/^#[0-9a-fA-F]{6}$/.test(opts.color)) {
      throw new Error(`cmux: refusing status color ${JSON.stringify(opts.color)} — expected #rrggbb`);
    }
    argv.push("--color", opts.color);
  }
  if (opts?.priority !== undefined) {
    if (!Number.isInteger(opts.priority)) {
      throw new Error(`cmux: refusing status priority ${String(opts.priority)} — must be an integer`);
    }
    argv.push("--priority", String(opts.priority));
  }
  return argv;
}

export function setProgressArgv(workspaceId: string, value: number, label?: string): string[] {
  assertCmuxValue("workspace id", workspaceId);
  // Clamp rather than throw: progress is cosmetic, and a 1.0000001 from
  // accumulated float error must not fail a run the control plane finished.
  const clamped = Math.min(1, Math.max(0, value));
  const argv = ["set-progress", clamped.toFixed(4), "--workspace", workspaceId];
  if (label !== undefined) {
    assertCmuxText("progress label", label);
    argv.push("--label", label);
  }
  return argv;
}

export function notifyArgv(workspaceId: string, title: string, body: string): string[] {
  assertCmuxValue("workspace id", workspaceId);
  assertCmuxText("notification title", title);
  assertCmuxText("notification body", body);
  return ["notify", "--title", title, "--body", body, "--workspace", workspaceId];
}

export function readScreenArgv(surfaceId: string, lines?: number): string[] {
  assertCmuxValue("surface id", surfaceId);
  const argv = ["read-screen", "--surface", surfaceId];
  if (lines !== undefined) argv.push("--lines", String(Math.max(1, Math.floor(lines))));
  return argv;
}

export function sendArgv(surfaceId: string, text: string): string[] {
  assertCmuxValue("surface id", surfaceId);
  assertCmuxText("send text", text);
  return ["send", "--surface", surfaceId, text];
}

export function sendKeyArgv(surfaceId: string, key: string): string[] {
  assertCmuxValue("surface id", surfaceId);
  assertCmuxValue("send key", key);
  return ["send-key", "--surface", surfaceId, key];
}

// ---------------------------------------------------------------------------
// The client.
// ---------------------------------------------------------------------------

export interface CmuxClientOptions {
  /** cmux binary; overridable so tests and PATH-less launchd contexts can pin it. */
  bin?: string;
  /**
   * Socket password (SRD §4.1 precedence: `--password`, then
   * `CMUX_SOCKET_PASSWORD`, then the Settings password). When set it is
   * delivered as `CMUX_SOCKET_PASSWORD` in the CHILD environment, never as a
   * `--password` argv: argv is world-readable in `ps` for the life of the
   * call, and precedence is preserved because an explicit child-env value
   * overrides whatever the parent environment held. When unset, the parent
   * env and cmux's own Settings fallback apply untouched.
   */
  password?: string;
  exec?: Exec;
  timeoutMs?: number;
}

export class CmuxError extends Error {
  constructor(argv: string[], result: ExecResult) {
    // stderr first — cmux writes its diagnosis there; note the password never
    // appears in argv, so this message is safe to surface and to log.
    const why = result.timedOut
      ? "timed out"
      : `exited ${result.code}: ${result.stderr.trim() || result.stdout.trim()}`.slice(0, 512);
    super(`cmux ${argv.join(" ")} ${why}`);
    this.name = "CmuxError";
  }
}

export class CmuxClient {
  private readonly bin: string;
  private readonly password: string | undefined;
  private readonly exec: Exec;
  private readonly timeoutMs: number;

  constructor(opts: CmuxClientOptions = {}) {
    this.bin = opts.bin ?? "cmux";
    this.password = opts.password;
    this.exec = opts.exec ?? realExec;
    // Presentation calls must never hold up the control plane for long: a
    // beachballing GUI is a cosmetic failure and 15s is already generous.
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  /** Raw invocation: non-zero exit is a RESULT here; callers decide meaning. */
  async run(argv: string[]): Promise<ExecResult> {
    const env: Record<string, string> = {};
    if (this.password !== undefined) env["CMUX_SOCKET_PASSWORD"] = this.password;
    return this.exec([this.bin, ...argv], { timeoutMs: this.timeoutMs, env });
  }

  /** Invocation where failure is exceptional; throws a `CmuxError` carrying stderr. */
  async runOk(argv: string[]): Promise<string> {
    const r = await this.run(argv);
    if (r.code !== 0) throw new CmuxError(argv, r);
    return r.stdout;
  }
}
