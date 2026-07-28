/**
 * The `tmux` backend: panes on a tmux server, for when cmux is absent or the
 * operator is on SSH (SRD §11).
 *
 * Presentation only, like every FleetBackend. The session and its panes are a
 * VIEW of the fleet; supervisors are launched detached by SupervisorLauncher
 * and are never pane children, so killing a pane — or the whole server —
 * cannot orphan a container. Nothing correctness-bearing may come from here,
 * and `readScreen` (capture-pane) exists for a human diagnosing a stuck pane,
 * never for code.
 *
 * Every tmux invocation goes through argv.ts builders that were probed
 * against the installed 3.6a binary; the probe record lives at the top of
 * that file and each deviation from documentation is noted where it bit.
 */

import type {
  Capability,
  FleetBackend,
  Notification,
  PaneRef,
  PaneSpec,
  WorkspaceRef,
} from "../types.ts";
import type { Exec } from "../../container/run.ts";
import { realExec } from "../../container/run.ts";
import {
  capturePaneArgv,
  hasSessionArgv,
  killSessionArgv,
  listPanesArgv,
  newSessionArgv,
  parsePaneId,
  parsePaneList,
  parseVersion,
  respawnPaneArgv,
  sanitizeSessionName,
  selectLayoutTiledArgv,
  selectPaneArgv,
  selectWindowArgv,
  sendKeyArgv,
  sendKeysLiteralArgv,
  setPaneTitleArgv,
  setWindowOptionArgv,
  splitWindowArgv,
  versionArgv,
  type TmuxContext,
} from "./argv.ts";

export interface TmuxBackendOptions extends TmuxContext {
  exec?: Exec;
  /**
   * Virtual size of the detached session. The default 80x24 refuses the 5th
   * split ("no space for new pane", probed); 220x50 with tiled relayout holds
   * an 8-worker fleet.
   */
  width?: number;
  height?: number;
}

const DEFAULT_WIDTH = 220;
const DEFAULT_HEIGHT = 50;

export class TmuxBackend implements FleetBackend {
  readonly kind = "tmux" as const;

  readonly #exec: Exec;
  readonly #ctx: TmuxContext;
  readonly #size: { width: number; height: number };

  /**
   * `new-session` necessarily creates pane 0; the first `createPane` claims
   * it instead of splitting, so N workers get exactly N panes rather than N
   * plus a stray shell nobody asked for. Keyed by session name because one
   * backend instance can serve several workspaces.
   */
  #unclaimed = new Map<string, string>();

  /**
   * The `@N` id of the window all panes live in, pinned at creation. Splits
   * and window options target this id rather than `=session:` because the
   * latter means "the session's CURRENT window" — one operator keystroke
   * (new-window, select-window) away from splitting the wrong window — and
   * because window options set with `-w` do not propagate to other windows
   * (probed), so they must land on this exact one.
   */
  #window = new Map<string, string>();

  /**
   * `respawn-pane` is the only way to change a pane's command, and it takes
   * the start directory at respawn time — so the cwd promised at createPane
   * has to be remembered until attachViewer needs it.
   */
  #paneCwd = new Map<string, string>();

  constructor(opts: TmuxBackendOptions = {}) {
    this.#exec = opts.exec ?? realExec;
    this.#ctx = {
      ...(opts.socketName !== undefined ? { socketName: opts.socketName } : {}),
      ...(opts.configFile !== undefined ? { configFile: opts.configFile } : {}),
    };
    this.#size = {
      width: opts.width ?? DEFAULT_WIDTH,
      height: opts.height ?? DEFAULT_HEIGHT,
    };
  }

  /** Run one tmux command; a non-zero exit is always an error with the stderr text. */
  async #tmux(argv: string[]): Promise<string> {
    const r = await this.#exec(argv, { timeoutMs: 15_000 });
    if (r.code !== 0) {
      const detail = r.stderr.trim() || r.stdout.trim() || `exit ${r.code ?? "timeout"}`;
      throw new Error(`${argv.join(" ")}: ${detail}`);
    }
    return r.stdout;
  }

  async probe(): Promise<Capability[]> {
    const r = await this.#exec(versionArgv(this.#ctx), { timeoutMs: 15_000 });
    const version = r.code === 0 ? parseVersion(r.stdout) : null;
    return [
      {
        name: "tmux",
        ok: version !== null,
        required: true,
        detail: version ?? `tmux not available (exit ${r.code ?? "timeout"})`,
      },
    ];
  }

  async ensureWorkspace(name: string): Promise<WorkspaceRef> {
    const session = sanitizeSessionName(name);
    const exists = await this.#exec(hasSessionArgv(this.#ctx, session), { timeoutMs: 15_000 });
    if (exists.code === 0) {
      // Idempotent path: adopt the existing session's window, claim nothing —
      // its panes belong to whoever created them.
      if (!this.#window.has(session)) {
        const panes = parsePaneList(await this.#tmux(listPanesArgv(this.#ctx, session)));
        const first = panes[0];
        if (first !== undefined) this.#window.set(session, first.windowId);
      }
      return { backend: this.kind, id: session };
    }

    await this.#tmux(newSessionArgv(this.#ctx, session, this.#size));
    const panes = parsePaneList(await this.#tmux(listPanesArgv(this.#ctx, session)));
    const first = panes[0];
    if (first === undefined) {
      // A session with no panes does not exist in tmux's model; seeing one
      // means our view of the server is wrong, which is not recoverable here.
      throw new Error(`tmux session ${session} created but reports no panes`);
    }
    this.#window.set(session, first.windowId);
    this.#unclaimed.set(session, first.paneId);

    // Worker ids on the borders: without this every pane is an anonymous
    // rectangle and the operator matches panes to workers by eye.
    await this.#tmux(setWindowOptionArgv(this.#ctx, first.windowId, "pane-border-status", "top"));
    // A crashed viewer keeps its last screen and a "Pane is dead" banner for
    // diagnosis instead of silently vanishing from the layout. The pane is a
    // view; a view disappearing is information destroyed.
    await this.#tmux(setWindowOptionArgv(this.#ctx, first.windowId, "remain-on-exit", "on"));
    return { backend: this.kind, id: session };
  }

  async createPane(w: WorkspaceRef, spec: PaneSpec): Promise<PaneRef> {
    const session = this.#requireId(w.id, "workspace");
    const windowId = this.#window.get(session);
    if (windowId === undefined) {
      throw new Error(`createPane before ensureWorkspace for session ${session}`);
    }
    let paneId: string;
    const initial = this.#unclaimed.get(session);
    if (initial !== undefined) {
      this.#unclaimed.delete(session);
      paneId = initial;
    } else {
      paneId = await this.#split(windowId, spec.cwd);
      // Re-tile after every split: sequential splits halve the smallest pane
      // until tmux refuses, so an untiled layout caps the fleet at ~4 panes.
      await this.#tmux(selectLayoutTiledArgv(this.#ctx, windowId));
    }
    this.#paneCwd.set(paneId, spec.cwd);
    await this.#tmux(setPaneTitleArgv(this.#ctx, paneId, spec.title ?? spec.workerId));
    return { backend: this.kind, id: paneId };
  }

  /**
   * One split, with one retry behind a relayout. "no space for new pane" is
   * tmux refusing to halve an already-minimal pane (probed at 80x24 after 4
   * splits); tiling first redistributes the space, after which the same split
   * usually fits. One retry, not a loop: if a tiled window still has no room,
   * the fleet genuinely does not fit and the error should surface.
   */
  async #split(windowId: string, cwd: string): Promise<string> {
    const argv = splitWindowArgv(this.#ctx, windowId, cwd);
    const first = await this.#exec(argv, { timeoutMs: 15_000 });
    if (first.code === 0) return parsePaneId(first.stdout);
    if (!/no space for new pane/i.test(first.stderr)) {
      throw new Error(`${argv.join(" ")}: ${first.stderr.trim() || `exit ${first.code ?? "timeout"}`}`);
    }
    await this.#tmux(selectLayoutTiledArgv(this.#ctx, windowId));
    return parsePaneId(await this.#tmux(argv));
  }

  async attachViewer(p: PaneRef, argv: string[]): Promise<void> {
    const paneId = this.#requireId(p.id, "pane");
    if (argv.length === 0) throw new Error("attachViewer: empty viewer argv");
    await this.#tmux(respawnPaneArgv(this.#ctx, paneId, this.#paneCwd.get(paneId), argv));
  }

  async focus(p: PaneRef): Promise<void> {
    const paneId = this.#requireId(p.id, "pane");
    // Two steps because a pane id names a pane, not its window: select-pane
    // alone would focus a pane the attached client cannot see.
    await this.#tmux(selectWindowArgv(this.#ctx, paneId));
    await this.#tmux(selectPaneArgv(this.#ctx, paneId));
  }

  async sendText(p: PaneRef, text: string): Promise<void> {
    await this.#tmux(sendKeysLiteralArgv(this.#ctx, this.#requireId(p.id, "pane"), text));
  }

  async sendKey(p: PaneRef, key: string): Promise<void> {
    await this.#tmux(sendKeyArgv(this.#ctx, this.#requireId(p.id, "pane"), key));
  }

  /** Diagnostics only (SRD §11) — never a source of control-plane fact. */
  async readScreen(p: PaneRef): Promise<string> {
    return this.#tmux(capturePaneArgv(this.#ctx, this.#requireId(p.id, "pane")));
  }

  async notify(_n: Notification): Promise<void> {
    // tmux display-message flashes on the status line of whoever is attached
    // — or nobody. Not implemented rather than pretending delivery happened.
  }

  async destroy(w: WorkspaceRef, opts: { keepPanes: boolean }): Promise<void> {
    const session = this.#requireId(w.id, "workspace");
    this.#unclaimed.delete(session);
    this.#window.delete(session);
    if (opts.keepPanes) return; // leave the view up for post-mortem reading
    const r = await this.#exec(killSessionArgv(this.#ctx, session), { timeoutMs: 15_000 });
    // "can't find session" / "no server running" after a run is success —
    // the view is already gone, and the view is all we own here. (Both
    // messages probed verbatim from 3.6a.)
    if (r.code !== 0 && !/can't find session|no server running/i.test(r.stderr)) {
      throw new Error(`kill-session ${session}: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
  }

  #requireId(id: string | null, what: string): string {
    if (id === null || id === "") {
      // A null id is the headless shape leaking in; an empty `-t` would make
      // tmux target "the active pane" — some pane, never reliably the right
      // one — so refuse before tmux gets the chance to guess.
      throw new Error(`tmux backend given a ${what} ref with no id`);
    }
    return id;
  }
}

/**
 * `PIFLEET_TMUX_SOCKET` supplies the `-L` name when the caller passes none.
 *
 * The socket has to be reachable from a SEPARATE process — `attach` runs long
 * after `up` exited — and the registry hands every backend the same opaque
 * options bag, so an env default is the one channel that survives a process
 * boundary without teaching the registry about tmux. Explicit options still
 * win; this only fills the gap.
 */
export function createTmuxBackend(opts: TmuxBackendOptions = {}): FleetBackend {
  const fromEnv = process.env["PIFLEET_TMUX_SOCKET"];
  const resolved: TmuxBackendOptions =
    opts.socketName === undefined && fromEnv !== undefined && fromEnv !== ""
      ? { ...opts, socketName: fromEnv }
      : opts;
  return new TmuxBackend(resolved);
}
