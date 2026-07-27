/**
 * The `headless` backend: no panes, no viewers, no GUI dependency.
 *
 * This is not a degraded mode — it is the backend the acceptance suite runs on
 * (SRD §11): if correctness can only be demonstrated with a GUI running, it
 * isn't demonstrated. Every method that would touch a presentation surface is
 * a no-op that succeeds, and every ref it hands out carries a `null` id so a
 * later phase cannot mistake it for something addressable.
 */

import type {
  Capability,
  FleetBackend,
  PaneRef,
  PaneSpec,
  WorkspaceRef,
} from "../types.ts";

export class HeadlessBackend implements FleetBackend {
  readonly kind = "headless" as const;

  /** Always available: headless requires nothing beyond the host itself. */
  async probe(): Promise<Capability[]> {
    return [{ name: "headless", ok: true, required: true }];
  }

  async ensureWorkspace(_name: string): Promise<WorkspaceRef> {
    return { backend: this.kind, id: null };
  }

  async createPane(_w: WorkspaceRef, _spec: PaneSpec): Promise<PaneRef> {
    return { backend: this.kind, id: null };
  }

  /** Viewers are deliberately not started (SRD §11): observability is `events.jsonl`. */
  async attachViewer(_p: PaneRef, _argv: string[]): Promise<void> {}

  async focus(_p: PaneRef): Promise<void> {}

  async destroy(_w: WorkspaceRef, _opts: { keepPanes: boolean }): Promise<void> {}
}

export function createHeadlessBackend(): FleetBackend {
  return new HeadlessBackend();
}
