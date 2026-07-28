/**
 * The `tmux` backend: panes on a tmux server, for when cmux is absent or the
 * operator is on SSH (SRD §11).
 *
 * Presentation only, like every FleetBackend. The session and its panes are a
 * VIEW of the fleet; supervisors are launched detached by SupervisorLauncher
 * and are never pane children, so killing a pane — or the whole server —
 * cannot orphan a container. Nothing correctness-bearing may come from here,
 * and `readScreen` (capture-pane) exists for a human diagnosing a stuck pane,
 * not for code.
 *
 * Every tmux invocation goes through argv.ts builders that were probed against
 * the installed 3.6a binary; see the notes there for what the probe showed.
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
  borderStatusArgv,
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
  splitWindowArgv,
  versionArgv,
  type TmuxContext,
} from "./argv.ts";

export interface TmuxBackendOptions extends TmuxContext {
  exec?: Exec;
  /**
   * Detached sessions default to 80x24, which runs out of splittable space
   * after a handful of panes ("no space for new pane"). A generous virtual
   * size plus a tiled relayout after every split keeps N-worker fleets viable.
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
   * `new-session` necessarily creates pane 0; the first `createPane` claims it
   * instead of splitting, so N workers get exactly N panes rather than N plus
   * a stray shell nobody asked for. Keyed by session name because one backend
   * instance can serve several workspaces.
   */
  #unclaimed = new Map<string, string>();

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
    if (exists.code !== 0) {
      await this.#tmux(newSessionArgv(this.#ctx, session, this.#size));
      // Worker ids on the borders: without this every pane is an anonymous
      // rectangle and the operator is left matching panes to workers by eye.
      await this.#tmux(borderStatusArgv(this.#ctx, session));
      const panes = parsePaneList(await this.#tmux(listPanesArgv(this.#ctx, session)));
      const first = panes[0];
      if (first !== undefined) this.#unclaimed.set(session, first.paneId);
    }
    return { backend: this.kind, id: session };
  }

  async createPane(w: WorkspaceRef, spec: PaneSpec): Promise<PaneRef> {
    const session = this.#requireId(w.id, "workspace");
    let paneId: string;
    const initial = this.#unclaimed.get(session);
    if (initial !== undefined) {
      this.#unclaimed.delete(session);
      paneId = initial;
    } else {
      paneId = parsePaneId(await this.#tmux(splitWindowArgv(this.#ctx, session, spec.cwd)));
      // Re-tile after every split: sequential splits halve the smallest pane
      // until tmux refuses, so an untiled layout caps the fleet size at ~4.
      await this.#tmux(selectLayoutTiledArgv(this.#ctx, session));
    }
    this.#paneCwd.set(paneId, spec.cwd);
    await this.#tmux(setPaneTitleArgv(this.#ctx, paneId, spec.title ?? spec.workerId));
    return { backend: this.kind, id: paneId };
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
    if (opts.keepPanes) return; // leave the view up for post-mortem reading
    const r = await this.#exec(killSessionArgv(this.#ctx, session), { timeoutMs: 15_000 });
    // "can't find session" after a run is success — someone or something
    // already tore the view down, and the view is all we own here.
    if (r.code !== 0 && !/can't find session|no server running/i.test(r.stderr)) {
      throw new Error(`kill-session ${session}: ${r.stderr.trim() || `exit ${r.code}`}`);
    }
  }

  #requireId(id: string | null, what: string): string {
    if (id === null || id === "") {
      // A null id is the headless shape leaking in; addressing tmux with it
      // would target "the current pane" — some pane, never the right one.
      throw new Error(`tmux backend given a ${what} ref with no id`);
    }
    return id;
  }
}

export function createTmuxBackend(opts: TmuxBackendOptions = {}): FleetBackend {
  return new TmuxBackend(opts);
}
