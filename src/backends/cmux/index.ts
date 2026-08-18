/**
 * The `cmux` backend — presentation plane only (SRD §3.1, §11).
 *
 * Everything here is cosmetic by contract: a lost pane never corrupts a
 * result, and no control-plane fact may originate from anything this module
 * touches. The two rules that make that true, and that this file must never
 * drift from:
 *
 *  1. The pane is a VIEW, not a channel. Panes run the viewer argv the caller
 *     supplies (`pifleet logs --follow --render`); dispatch and harvest flow
 *     through the supervisor's RPC pipes and the run directory, neither of
 *     which this module can even name.
 *  2. `readScreen` is diagnostics only (ISC-136). It exists on the interface
 *     so `doctor` can show a human what a pane looks like; nothing here calls
 *     it and nothing downstream may treat its output as state. The live probe
 *     for this phase watched it fail (`internal_error`) on a healthy
 *     background surface — a correctness path built on it would flake exactly
 *     there.
 *
 * The seam rule (ISC-137): no file outside `src/backends/cmux/` imports a
 * cmux symbol. This module speaks `FleetBackend` outward and cmux argv inward.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  Capability,
  FleetBackend,
  Notification,
  PaneRef,
  PaneSpec,
  StatusOpts,
  WorkspaceRef,
} from "../types.ts";
import {
  CmuxClient,
  assertCmuxValue,
  focusPaneArgv,
  listPanesArgv,
  newSplitArgv,
  notifyArgv,
  readScreenArgv,
  renameTabArgv,
  respawnPaneArgv,
  sendArgv,
  sendKeyArgv,
  setProgressArgv,
  setStatusArgv,
  workspaceCloseArgv,
  workspaceCreateArgv,
  workspaceListArgv,
  type CmuxClientOptions,
  type SplitDirection,
} from "./client.ts";
import { CmuxUnavailableError, DIAG, probeCmux } from "./capabilities.ts";
import {
  composePaneId,
  findWorkspaceByTitle,
  parseListPanes,
  parseNewSplit,
  parseWorkspaceCreate,
  parseWorkspaceList,
  shellQuote,
  splitPaneId,
} from "./parse.ts";

export interface CmuxBackendOptions extends CmuxClientOptions {
  /**
   * Where viewer launch scripts are written. Callers that own a run directory
   * should point this into it so the scripts die with the run; the tmpdir
   * default keeps the backend constructible without one.
   */
  viewerScriptDir?: string;
  /** Pane cwd default for freshly created workspaces. */
  cwd?: string;
}

/**
 * Tracks the one piece of state a presentation backend legitimately has: which
 * surface to split from next, and whether the workspace's initial pane is
 * still unclaimed. Losing this state loses LAYOUT, nothing else — a restart
 * re-discovers panes via `list-panes`.
 */
interface WorkspaceLayout {
  /** The initial surface a `workspace create` opens with; consumed by the first pane. */
  initialSurface: string | null;
  initialPane: string | null;
  /** Last surface created; the next split hangs off it. */
  lastSurface: string | null;
  splits: number;
}

export class CmuxBackend implements FleetBackend {
  readonly kind = "cmux" as const;
  private readonly client: CmuxClient;
  private readonly viewerScriptDir: string;
  private readonly cwd: string | undefined;
  private readonly layouts = new Map<string, WorkspaceLayout>();
  /** setStatus/setProgress/notify carry no target in the seam; they address the fleet workspace. */
  private workspaceId: string | null = null;

  constructor(opts: CmuxBackendOptions = {}) {
    this.client = new CmuxClient(opts);
    this.viewerScriptDir = opts.viewerScriptDir ?? join(tmpdir(), "pifleet-cmux-viewers");
    this.cwd = opts.cwd;
  }

  async probe(): Promise<Capability[]> {
    return (await probeCmux(this.client)).capabilities;
  }

  /**
   * Find-or-create the fleet workspace. Reuse is matched on `custom_title`
   * (round-trips `--name`, SRD §4.1) so a crashed `up` re-attaches instead of
   * littering the operator's sidebar with duplicates.
   *
   * This is the first socket-touching call in `up`'s sequence, so it is where
   * "socket unreachable → exit 3 with a named diagnosis" (ISC-131) surfaces:
   * the probe runs first and its fatal — a `CmuxUnavailableError` carrying
   * `EXIT.BACKEND_UNAVAILABLE` — is thrown rather than reported.
   */
  async ensureWorkspace(name: string): Promise<WorkspaceRef> {
    const report = await probeCmux(this.client);
    if (report.fatal !== null) throw report.fatal;

    const listed = await this.client.run(workspaceListArgv());
    if (listed.code === 0) {
      const existing = findWorkspaceByTitle(parseWorkspaceList(listed.stdout), name);
      if (existing !== null) {
        this.workspaceId = existing.id;
        // Unknown layout: panes may exist from a previous run. Splits will
        // anchor off whatever list-panes reports at createPane time.
        this.layouts.set(existing.id, {
          initialSurface: null,
          initialPane: null,
          lastSurface: null,
          splits: 0,
        });
        return { backend: this.kind, id: existing.id };
      }
    }
    // `list` failing after a green probe is odd but not fatal — create is the
    // action that matters, and IT failing is loud below.

    const created = parseWorkspaceCreate(
      await this.client.runOk(workspaceCreateArgv(name, this.cwd)),
    );
    this.workspaceId = created.workspaceId;
    this.layouts.set(created.workspaceId, {
      initialSurface: created.surfaceId,
      initialPane: null,
      lastSurface: created.surfaceId,
      splits: 0,
    });
    return { backend: this.kind, id: created.workspaceId };
  }

  /**
   * One pane per worker (ISC-129). The workspace's initial pane is consumed
   * first — leaving it as a stray idle shell while splitting N more is the
   * kind of clutter that makes an operator distrust the display — and later
   * panes alternate right/down splits off the previous surface, which yields
   * a roughly balanced grid without depending on the undocumented
   * `--layout <json>` schema (SRD §19 Q3).
   */
  async createPane(w: WorkspaceRef, spec: PaneSpec): Promise<PaneRef> {
    const wsId = this.requireWorkspaceId(w);
    const layout = this.layouts.get(wsId) ?? {
      initialSurface: null,
      initialPane: null,
      lastSurface: null,
      splits: 0,
    };
    this.layouts.set(wsId, layout);

    let paneId: string;
    let surfaceId: string;

    if (layout.initialSurface !== null) {
      // Claim the initial pane. Its pane id was not in the create output, so
      // ask list-panes — the authoritative enumeration either way.
      surfaceId = layout.initialSurface;
      layout.initialSurface = null;
      const panes = parseListPanes(await this.client.runOk(listPanesArgv(wsId)));
      const owner = panes.find((p) => p.selectedSurfaceId === surfaceId) ?? panes[0];
      if (owner === undefined) {
        throw new CmuxUnavailableError(
          DIAG.socketUnreachable,
          `workspace ${wsId} reports no panes immediately after creation`,
        );
      }
      paneId = owner.paneId;
    } else {
      // Split off the most recent surface; fall back to live enumeration when
      // this backend instance did not create the workspace.
      let anchor = layout.lastSurface;
      if (anchor === null) {
        const panes = parseListPanes(await this.client.runOk(listPanesArgv(wsId)));
        anchor = panes.at(-1)?.selectedSurfaceId ?? null;
        if (anchor === null) {
          throw new CmuxUnavailableError(
            DIAG.socketUnreachable,
            `workspace ${wsId} has no surface to split from`,
          );
        }
      }
      const dir: SplitDirection = layout.splits % 2 === 0 ? "right" : "down";
      const split = parseNewSplit(await this.client.runOk(newSplitArgv(wsId, anchor, dir)));
      paneId = split.paneId;
      surfaceId = split.surfaceId;
    }

    layout.lastSurface = surfaceId;
    layout.splits += 1;

    // Tab title = worker id, so the pane is identifiable before its viewer
    // draws a byte (ISC-129). Best-effort: a failed rename must not fail a
    // pane that exists — the viewer prints the worker id anyway.
    const title = spec.title ?? spec.workerId;
    try {
      await this.client.runOk(renameTabArgv(wsId, surfaceId, title));
    } catch {
      // Presentation-of-presentation; losing it costs a label, not a fact.
    }

    return { backend: this.kind, id: composePaneId(paneId, surfaceId, wsId) };
  }

  /**
   * Start the viewer in a pane. The argv goes into a 0700 script and cmux is
   * told `sh <path>`: `--command`-style text is TYPED INTO the pane's shell,
   * not exec'd (SRD §4.1), so interpolating the argv itself would make every
   * config string shell syntax. The script is the quoting boundary, written by
   * us, spawned by path.
   */
  async attachViewer(p: PaneRef, argv: string[]): Promise<void> {
    const { surfaceId, workspaceId } = splitPaneId(this.requirePaneId(p));
    if (argv.length === 0) throw new Error("cmux: attachViewer requires a non-empty argv");

    /**
     * Validate BEFORE the id becomes a path, not after.
     *
     * The guard existed but ran too late: its only caller was
     * `respawnPaneArgv`, on the last line of this method, while `surfaceId`
     * was interpolated into a filename and written with mode 0700 several
     * lines earlier. `splitPaneId` requires only three non-empty
     * space-separated parts, so `/` and `.` both survive it, and a surfaceId
     * like `x/../../victim/target` escapes `viewerScriptDir` into a sibling
     * directory — an arbitrary-file overwrite with attacker-influenced
     * `#!/bin/sh` content. The `viewer-` prefix absorbs a plain leading
     * `../`, which is what makes the naive attempt fail and the real one easy
     * to miss.
     *
     * The comment that used to sit here claimed the id was "already validated
     * to be path-safe by the identifier grammar". It was not, at this point
     * in the method. The value arrives from cmux's own JSON, so exploiting it
     * needs a hostile or broken cmux — but this is now reachable from every
     * `up` on the cmux backend, which is exactly the kind of ordering bug
     * that stays latent until something wires the caller in.
     */
    assertCmuxValue("surface id", surfaceId);

    await mkdir(this.viewerScriptDir, { recursive: true, mode: 0o700 });
    // Keyed by surface UUID: unique per pane and stable across re-attach.
    const script = join(this.viewerScriptDir, `viewer-${surfaceId}.sh`);
    const body =
      "#!/bin/sh\n" +
      "# pifleet viewer launch — generated. The pane is a VIEW: closing it, or this\n" +
      "# viewer dying, must never affect the detached supervisor or its container.\n" +
      `exec ${shellQuote(argv)}\n`;
    await writeFile(script, body, { mode: 0o700 });

    await this.client.runOk(respawnPaneArgv(workspaceId, surfaceId, `sh ${shellQuote([script])}`));
  }

  /** `pifleet attach --worker <id>` lands here (ISC-130). */
  async focus(p: PaneRef): Promise<void> {
    const { paneId } = splitPaneId(this.requirePaneId(p));
    await this.client.runOk(focusPaneArgv(paneId));
  }

  /** tui mode only (SRD §3.5): typed text, with the pane's shell doing the reading. */
  async sendText(p: PaneRef, text: string): Promise<void> {
    const { surfaceId } = splitPaneId(this.requirePaneId(p));
    await this.client.runOk(sendArgv(surfaceId, text));
  }

  async sendKey(p: PaneRef, key: string): Promise<void> {
    const { surfaceId } = splitPaneId(this.requirePaneId(p));
    await this.client.runOk(sendKeyArgv(surfaceId, key));
  }

  /** Sidebar pill per worker, keyed by worker id (SRD §4.1). */
  async setStatus(k: string, v: string, o?: StatusOpts): Promise<void> {
    const opts: { icon?: string; color?: string; priority?: number } = {};
    if (o?.icon !== undefined) opts.icon = o.icon;
    if (o?.color !== undefined) opts.color = o.color;
    if (o?.priority !== undefined) opts.priority = o.priority;
    await this.client.runOk(setStatusArgv(this.requireFleetWorkspace(), k, v, opts));
  }

  /** Run progress — singular per workspace by cmux's own model (SRD §4.1). */
  async setProgress(v: number, label?: string): Promise<void> {
    await this.client.runOk(setProgressArgv(this.requireFleetWorkspace(), v, label));
  }

  async notify(n: Notification): Promise<void> {
    await this.client.runOk(notifyArgv(this.requireFleetWorkspace(), n.title, n.body));
  }

  /**
   * DIAGNOSTICS ONLY (ISC-136). Nothing in this backend calls this; nothing
   * outside `doctor`-shaped tooling may. Failure is expected in the wild —
   * probed live: `internal_error: Failed to read terminal text` on a fresh
   * background surface — and throws so the diagnostic caller reports "could
   * not read" instead of mistaking an empty string for an empty screen.
   */
  async readScreen(p: PaneRef): Promise<string> {
    const { surfaceId } = splitPaneId(this.requirePaneId(p));
    return this.client.runOk(readScreenArgv(surfaceId, 200));
  }

  /**
   * Teardown. `keepPanes: true` is a full no-op by design: `down --keep-panes`
   * means the operator wants the evidence on screen, and there is no cmux verb
   * for "close the workspace but keep its panes" anyway — the panes ARE the
   * workspace's content.
   */
  async destroy(w: WorkspaceRef, opts: { keepPanes: boolean }): Promise<void> {
    const wsId = this.requireWorkspaceId(w);
    if (opts.keepPanes) return;
    await this.client.runOk(workspaceCloseArgv(wsId));
    this.layouts.delete(wsId);
    if (this.workspaceId === wsId) this.workspaceId = null;
  }

  private requireWorkspaceId(w: WorkspaceRef): string {
    if (w.backend !== this.kind || w.id === null) {
      // A headless ref reaching a cmux backend means two backends got crossed
      // somewhere upstream; acting on it would drive someone else's terminal.
      throw new Error(`cmux: not a cmux workspace ref: ${JSON.stringify(w)}`);
    }
    return w.id;
  }

  private requirePaneId(p: PaneRef): string {
    if (p.backend !== this.kind || p.id === null) {
      throw new Error(`cmux: not a cmux pane ref: ${JSON.stringify(p)}`);
    }
    return p.id;
  }

  private requireFleetWorkspace(): string {
    if (this.workspaceId === null) {
      throw new Error("cmux: no fleet workspace yet — ensureWorkspace() must run first");
    }
    return this.workspaceId;
  }
}

export function createCmuxBackend(opts: CmuxBackendOptions = {}): FleetBackend {
  return new CmuxBackend(opts);
}

export { CmuxUnavailableError, DIAG, probeCmux, REQUIRED_COMMANDS } from "./capabilities.ts";
