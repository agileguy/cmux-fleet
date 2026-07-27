/**
 * Backend abstraction (SRD §11).
 *
 * Two interfaces, deliberately separate. v1.1 put `spawn(pane, argv, env)` on
 * the backend, which made the supervisor a pane child and contradicted the
 * detached-supervisor requirement it was meant to serve (SRD §3.3): closing a
 * pane — a cosmetic act — would have orphaned a container. Spawning a
 * supervisor is therefore `SupervisorLauncher`, backend-independent, and a
 * `FleetBackend` is presentation only.
 *
 * The seam rule: no file outside `src/backends/cmux/` may import a cmux symbol
 * (ISC-137). Everything the rest of the system needs is expressed here.
 */

export type BackendKind = "cmux" | "tmux" | "headless";

/** One probed fact about a backend, reported by `doctor` and checked at `up`. */
export interface Capability {
  name: string;
  ok: boolean;
  required: boolean;
  detail?: string;
}

export interface WorkspaceRef {
  backend: BackendKind;
  /** Backend-native identifier; `null` on `headless`, which has no workspaces. */
  id: string | null;
}

export interface PaneRef {
  backend: BackendKind;
  /** Backend-native identifier; `null` on `headless`, which has no panes. */
  id: string | null;
}

export interface PaneSpec {
  workerId: string;
  cwd: string;
  title?: string;
}

export interface StatusOpts {
  icon?: string;
  color?: string;
  priority?: number;
}

export interface Notification {
  title: string;
  body: string;
}

/**
 * Everything a launcher needs to start one detached supervisor. `argv` is the
 * complete command line; the launcher adds nothing to it, so what runs is
 * exactly what `render` would print.
 */
export interface WorkerSpec {
  runId: string;
  runDir: string;
  workerId: string;
  argv: string[];
  env: Record<string, string>;
  /** Where the supervisor's own stdout/stderr are appended. */
  logPath: string;
}

/**
 * Backend-independent supervisor lifecycle (SRD §11). The returned `pgid`
 * must equal `pid`: the supervisor is a session leader, not anyone's child
 * (ISC-77/78), and the launcher's death must not propagate.
 */
export interface SupervisorLauncher {
  launchDetached(spec: WorkerSpec): Promise<{ pid: number; pgid: number }>;
}

/** Presentation plane only. Nothing correctness-bearing may live behind this. */
export interface FleetBackend {
  readonly kind: BackendKind;
  probe(): Promise<Capability[]>;
  ensureWorkspace(name: string): Promise<WorkspaceRef>;
  createPane(w: WorkspaceRef, spec: PaneSpec): Promise<PaneRef>;
  attachViewer(p: PaneRef, argv: string[]): Promise<void>;
  focus(p: PaneRef): Promise<void>;
  sendText?(p: PaneRef, text: string): Promise<void>; // tui only
  sendKey?(p: PaneRef, key: string): Promise<void>; // tui only
  setStatus?(k: string, v: string, o?: StatusOpts): Promise<void>;
  setProgress?(v: number, label?: string): Promise<void>;
  notify?(n: Notification): Promise<void>;
  readScreen?(p: PaneRef): Promise<string>; // diagnostics only — never correctness-bearing
  destroy(w: WorkspaceRef, opts: { keepPanes: boolean }): Promise<void>;
}
