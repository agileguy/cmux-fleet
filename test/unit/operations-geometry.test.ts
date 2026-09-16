/**
 * `applyBottomWidths` against a SPLIT-TREE MODEL of cmux layout, not a fixed
 * fixture.
 *
 * Every test in `operations-workspace.test.ts` scripts `list-panes` with a
 * hand-written pane list and no `container_frame`, so nothing there ever
 * exercises the resize arithmetic — the geometry read throws and both
 * correction passes take their early return. This file instead runs a small
 * binary-tree model of how `new-split` and `resize-pane` actually behave (a
 * leaf per pane, a split per divider, `ratio` the first child's share), wired
 * up as a `CmuxClient` with a scripted `exec`, so the ORDER and the TARGETS of
 * every `list-panes`/`resize-pane` call are re-checked against something that
 * redistributes width the way the live console measured on 2026-09-13
 * actually does — proportionally, across a whole subtree, not between flat
 * neighbours.
 *
 * Everything below goes through the exported {@link createWorkspace}. Nothing
 * here reaches into `applyBottomWidths` directly — it is not exported, and the
 * point of this suite is that the generalization is provable from the outside.
 */
import { describe, expect, test } from "bun:test";

import { CmuxClient } from "../../src/backends/cmux/client.ts";
import type { SplitDirection } from "../../src/backends/cmux/client.ts";
import type { ExecResult } from "../../src/container/run.ts";
import {
  OPERATIONS_TOP_FRACTION,
  REVIEW_TOP_FRACTION,
  TRIAGE_OBSERVER_ROW_FRACTION,
  TRIAGE_TOP_FRACTION,
  collatorOverRowPanes,
} from "../../src/backends/cmux/operations-plan.ts";
import {
  DEVELOPMENT_SPEC,
  OPERATIONS_SPEC,
  REVIEW_SPEC,
  TRIAGE_SPEC,
  createWorkspace,
  type WorkspaceSpec,
} from "../../src/backends/cmux/operations.ts";

// ---------------------------------------------------------------------------
// The model: a binary split tree, faithful enough to reproduce the live
// measurement `applyBottomWidths`' own docblock cites.
// ---------------------------------------------------------------------------

/**
 * Measured live 2026-09-13: the width is `TRIAGE_OBSERVER_WIDTH_FRACTION`'s
 * docblock (`operations-plan.ts`); the height and both offsets are
 * `parsePaneGeometry`'s (`parse.ts`).
 */
const CONTAINER_WIDTH = 795.33;
const CONTAINER_HEIGHT = 1052;
/** Live cmux reports ABSOLUTE coordinates — a window offset, not an origin. */
const OFFSET_X = 264.67;
const OFFSET_Y = 28;
const MIN_PANE_PX = 20;

interface SurfaceLeaf {
  kind: "leaf";
  pane: string;
  surface: string;
}
interface SplitNode {
  kind: "split";
  orientation: "v" | "h";
  /** The share of this node's own box that side `a` gets. */
  ratio: number;
  a: LayoutNode;
  b: LayoutNode;
}
type LayoutNode = SurfaceLeaf | SplitNode;

interface Box {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** Every node's box, computed top-down from the current ratios. */
function computeBoxes(
  node: LayoutNode,
  x: number,
  y: number,
  w: number,
  h: number,
  out: Map<LayoutNode, Box> = new Map(),
): Map<LayoutNode, Box> {
  out.set(node, { x, y, w, h });
  if (node.kind === "split") {
    if (node.orientation === "v") {
      const ah = h * node.ratio;
      computeBoxes(node.a, x, y, w, ah, out);
      computeBoxes(node.b, x, y + ah, w, h - ah, out);
    } else {
      const aw = w * node.ratio;
      computeBoxes(node.a, x, y, aw, h, out);
      computeBoxes(node.b, x + aw, y, w - aw, h, out);
    }
  }
  return out;
}

/**
 * A cmux workspace as a split tree. Starts as one leaf (`pane-0`/`surf-0`),
 * the surface `workspace create` opens with.
 *
 * `new-split` replaces the leaf it targets with a 2-child split at ratio 0.5.
 * `resize-pane` walks from a pane up to the nearest ancestor split with a
 * border on the requested side and moves that split's ratio — which is what
 * makes a resize redistribute PROPORTIONALLY across everything on the far
 * side of that border, exactly as `applyBottomWidths`' docblock measured.
 */
class LayoutModel {
  root: LayoutNode;
  /** Pane ids in CREATION order — what `list-panes` reports them in here. */
  paneOrder: string[] = ["pane-0"];
  private splitCounter = 0;
  private leafByPane = new Map<string, SurfaceLeaf>();
  private leafBySurface = new Map<string, SurfaceLeaf>();

  constructor() {
    const initial: SurfaceLeaf = { kind: "leaf", pane: "pane-0", surface: "surf-0" };
    this.root = initial;
    this.leafByPane.set("pane-0", initial);
    this.leafBySurface.set("surf-0", initial);
  }

  newSplit(dir: SplitDirection, targetSurfaceId: string): { paneId: string; surfaceId: string } {
    const leaf = this.leafBySurface.get(targetSurfaceId);
    if (leaf === undefined) throw new Error(`model: no pane holds surface ${targetSurfaceId}`);
    this.splitCounter += 1;
    const n = this.splitCounter;
    const newPaneId = `pane-${n}`;
    const newSurfaceId = `surf-${n}`;
    const newLeaf: SurfaceLeaf = { kind: "leaf", pane: newPaneId, surface: newSurfaceId };
    // A fresh object for the OLD side too: the object this replaces (`leaf`)
    // may be `this.root` itself, and `root` is reassigned rather than mutated
    // in place below.
    const oldSide: SurfaceLeaf = { kind: "leaf", pane: leaf.pane, surface: leaf.surface };
    let split: SplitNode;
    switch (dir) {
      case "down":
        split = { kind: "split", orientation: "v", ratio: 0.5, a: oldSide, b: newLeaf };
        break;
      case "up":
        split = { kind: "split", orientation: "v", ratio: 0.5, a: newLeaf, b: oldSide };
        break;
      case "right":
        split = { kind: "split", orientation: "h", ratio: 0.5, a: oldSide, b: newLeaf };
        break;
      case "left":
        split = { kind: "split", orientation: "h", ratio: 0.5, a: newLeaf, b: oldSide };
        break;
    }
    this.replace(leaf, split);
    this.leafBySurface.set(newSurfaceId, newLeaf);
    this.leafBySurface.set(targetSurfaceId, oldSide);
    this.leafByPane.set(newPaneId, newLeaf);
    this.leafByPane.set(leaf.pane, oldSide);
    this.paneOrder.push(newPaneId);
    return { paneId: newPaneId, surfaceId: newSurfaceId };
  }

  /**
   * `U` needs a v-split with the pane in `b`; `D` needs v with the pane in
   * `a`; `L` needs h with the pane in `b`; `R` needs h with the pane in `a` —
   * the nearest such ancestor, walking UP from the leaf. `D`/`R` grow `a`;
   * `U`/`L` shrink it. Each side is clamped to at least {@link MIN_PANE_PX}.
   */
  resize(paneId: string, dir: "U" | "D" | "L" | "R", amount: number): { ok: true } | { ok: false; error: string } {
    const found = this.pathTo(this.root, paneId, []);
    if (found === null) return { ok: false, error: `invalid_state: unknown pane ${paneId}` };
    const needOrientation = dir === "U" || dir === "D" ? "v" : "h";
    const needSide = dir === "D" || dir === "R" ? "a" : "b";
    let target: SplitNode | null = null;
    for (let i = found.path.length - 1; i >= 0; i -= 1) {
      const step = found.path[i]!;
      if (step.node.orientation === needOrientation && step.side === needSide) {
        target = step.node;
        break;
      }
    }
    if (target === null) {
      return { ok: false, error: `invalid_state: Pane has no adjacent border in direction ${dir}` };
    }
    const boxes = computeBoxes(this.root, OFFSET_X, OFFSET_Y, CONTAINER_WIDTH, CONTAINER_HEIGHT);
    const box = boxes.get(target)!;
    const dim = target.orientation === "v" ? box.h : box.w;
    let aSize = dim * target.ratio + (dir === "D" || dir === "R" ? amount : -amount);
    aSize = Math.min(Math.max(aSize, MIN_PANE_PX), dim - MIN_PANE_PX);
    target.ratio = aSize / dim;
    return { ok: true };
  }

  /** Every pane's current absolute pixel frame, by pane id. */
  frames(): Map<string, { x: number; y: number; width: number; height: number }> {
    const boxes = computeBoxes(this.root, OFFSET_X, OFFSET_Y, CONTAINER_WIDTH, CONTAINER_HEIGHT);
    const out = new Map<string, { x: number; y: number; width: number; height: number }>();
    for (const [paneId, leaf] of this.leafByPane) {
      const box = boxes.get(leaf)!;
      out.set(paneId, { x: box.x, y: box.y, width: box.w, height: box.h });
    }
    return out;
  }

  /**
   * The `list-panes --json --id-format uuids` body.
   *
   * `order` defaults to CREATION order — today's behaviour, and what every
   * test that does not pass it keeps getting. `"reverse"` exists to prove the
   * two correction passes read geometry rather than positional array index:
   * every computation in `applyTopFraction`, `applyMiddleRowFraction` and
   * `applyBottomWidths` is `Math.min`/`Math.max`/`.find`/`.filter` over the
   * panes' own `y`/`x`/`paneId` fields, none of which cmux promises an ORDER
   * for — so a test that only ever sees creation order could pass by accident
   * on an implementation that silently assumed `panes[0]` was the top-left.
   */
  listPanesJson(order: "creation" | "reverse" = "creation"): unknown {
    const boxes = computeBoxes(this.root, OFFSET_X, OFFSET_Y, CONTAINER_WIDTH, CONTAINER_HEIGHT);
    const ids = order === "reverse" ? [...this.paneOrder].reverse() : this.paneOrder;
    const panes = ids.map((paneId, i) => {
      const leaf = this.leafByPane.get(paneId)!;
      const box = boxes.get(leaf)!;
      return {
        id: paneId,
        selected_surface_id: leaf.surface,
        index: i,
        pixel_frame: { x: box.x, y: box.y, width: box.w, height: box.h },
      };
    });
    return { container_frame: { width: CONTAINER_WIDTH, height: CONTAINER_HEIGHT }, panes };
  }

  private replace(target: LayoutNode, replacement: LayoutNode): void {
    if (this.root === target) {
      this.root = replacement;
      return;
    }
    const parent = this.findParent(this.root, target);
    if (parent === null) throw new Error("model: node not found in tree");
    parent.node[parent.side] = replacement;
  }

  private findParent(node: LayoutNode, target: LayoutNode): { node: SplitNode; side: "a" | "b" } | null {
    if (node.kind !== "split") return null;
    if (node.a === target) return { node, side: "a" };
    if (node.b === target) return { node, side: "b" };
    return this.findParent(node.a, target) ?? this.findParent(node.b, target);
  }

  private pathTo(
    node: LayoutNode,
    paneId: string,
    path: { node: SplitNode; side: "a" | "b" }[],
  ): { leaf: SurfaceLeaf; path: { node: SplitNode; side: "a" | "b" }[] } | null {
    if (node.kind === "leaf") {
      return node.pane === paneId ? { leaf: node, path } : null;
    }
    return (
      this.pathTo(node.a, paneId, [...path, { node, side: "a" }]) ??
      this.pathTo(node.b, paneId, [...path, { node, side: "b" }])
    );
  }
}

const ok = (stdout: string): ExecResult => ({ code: 0, stdout, stderr: "", timedOut: false });

interface FakeCmux {
  client: CmuxClient;
  /** Every argv issued, bin stripped — `argv[0]` is the verb. */
  calls: string[][];
  /** `pane-N` -> the title `rename-tab` gave it, populated as panes are built. */
  titleByPane: Map<string, string>;
}

/**
 * A `CmuxClient` scripted against a {@link LayoutModel} instead of a fixed
 * fixture. `afterBuild`, if given, runs on the ONE `select-workspace` call
 * {@link createWorkspace} issues right after every pane is split, renamed and
 * respawned — and before any correction pass reads geometry — so a test can
 * pre-shape the layout the passes will see. `paneOrder` controls the order
 * `list-panes` reports panes in; see {@link LayoutModel.listPanesJson}.
 */
function fakeCmux(
  model: LayoutModel,
  opts: { afterBuild?: (model: LayoutModel) => void; paneOrder?: "creation" | "reverse" } = {},
): FakeCmux {
  const calls: string[][] = [];
  const titleByPane = new Map<string, string>();
  let afterBuildRan = false;
  const client = new CmuxClient({
    exec: async (argv): Promise<ExecResult> => {
      const a = argv.slice(1);
      calls.push(a);
      switch (a[0]) {
        case "ping":
          return ok("");
        case "workspace": {
          const sub = a[1];
          if (sub === "list") return ok(JSON.stringify({ window_id: "win-1", workspaces: [] }));
          if (sub === "create") {
            return ok(JSON.stringify({ workspace_id: "ws-new", surface_id: "surf-0", window_id: "win-1" }));
          }
          if (sub === "group") return ok(JSON.stringify({ groups: [] }));
          return ok("");
        }
        case "new-split": {
          const dir = a[1] as SplitDirection;
          const surface = a[a.indexOf("--surface") + 1]!;
          const created = model.newSplit(dir, surface);
          return ok(JSON.stringify({ pane_id: created.paneId, surface_id: created.surfaceId }));
        }
        case "select-workspace":
          if (opts.afterBuild !== undefined && !afterBuildRan) {
            afterBuildRan = true;
            opts.afterBuild(model);
          }
          return ok("");
        case "list-panes":
          return ok(JSON.stringify(model.listPanesJson(opts.paneOrder ?? "creation")));
        case "resize-pane": {
          const paneId = a[a.indexOf("--pane") + 1]!;
          const dirFlag = a.find((x) => /^-[UDLR]$/.test(x))!;
          const dir = dirFlag.slice(1) as "U" | "D" | "L" | "R";
          const amount = Number(a[a.indexOf("--amount") + 1]);
          const res = model.resize(paneId, dir, amount);
          if (!res.ok) return { code: 1, stdout: "", stderr: res.error, timedOut: false };
          return ok("");
        }
        case "rename-tab": {
          const surface = a[a.indexOf("--surface") + 1]!;
          const title = a[a.indexOf("--title") + 1]!;
          titleByPane.set(surface.replace("surf-", "pane-"), title);
          return ok("");
        }
        case "respawn-pane":
        case "focus-pane":
          return ok("");
        default:
          return ok("");
      }
    },
  });
  return { client, calls, titleByPane };
}

function paneIdFor(titleByPane: Map<string, string>, title: string): string {
  for (const [paneId, t] of titleByPane) if (t === title) return paneId;
  throw new Error(`fakeCmux: no pane titled '${title}'`);
}

/**
 * A TOP-ROW pane's id, found by geometry rather than by title: the pane with
 * the smallest `y`, the first in creation order on a tie. A height assertion on
 * the top row does not need to know which pane it holds, and the operations
 * console's top-left title is one the role-rename sweep keeps out of quoted
 * literals in this file.
 */
function topRowPaneId(model: LayoutModel): string {
  let best: { id: string; y: number } | null = null;
  for (const [id, f] of model.frames()) if (best === null || f.y < best.y) best = { id, y: f.y };
  if (best === null) throw new Error("model: no panes");
  return best.id;
}

/**
 * `applyBottomWidths`' own left-to-right, one-border-at-a-time algorithm,
 * reproduced against the MODEL directly (never through `client`/argv) so a
 * test can pre-shape a row to an arbitrary target rather than only the
 * fraction the production pass would apply.
 */
function settleRowWidths(model: LayoutModel, rowPaneIdsLeftToRight: readonly string[], fraction: number): void {
  for (let i = 0; i < rowPaneIdsLeftToRight.length - 1; i += 1) {
    const paneId = rowPaneIdsLeftToRight[i]!;
    const nextId = rowPaneIdsLeftToRight[i + 1]!;
    const pane = model.frames().get(paneId)!;
    const delta = CONTAINER_WIDTH * fraction - pane.width;
    if (Math.abs(delta) < 1) continue;
    if (delta > 0) model.resize(paneId, "R", delta);
    else model.resize(nextId, "L", -delta);
  }
}

const REPO = "/Users/x/repos/cmux-fleet";
const CWD = "/Users/x/repos/somewhere-else";
const OPTS = { repoRoot: REPO, watchDir: CWD };

/** Same shape `collatorOverRowPanes` gives a 4-worker console: one header pane full width, one row of three beneath it. */
const GEOM_TEST_WORKERS = ["hdr", "gp1", "gp2", "gp3"];
const GEOM_SPEC: WorkspaceSpec = {
  name: "geom-test",
  panes: (opts) => collatorOverRowPanes(opts, GEOM_TEST_WORKERS, "geom-test"),
  topFraction: null,
  bottomWidthFraction: null,
};

/**
 * Exactly `applyBottomWidths`' 9-call sequence, captured against the UNMODIFIED
 * pass on `REVIEW_SPEC`. Every `resize-pane` entry carries `--workspace
 * ws-new` — `resizePaneArgv` used to omit it, which is exactly the bug that
 * reached a live triage rebuild on 2026-09-15; see that builder's own docblock
 * for the reproduction.
 */
const GOLDEN_REVIEW_SEQUENCE: string[][] = [
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["resize-pane", "--pane", "pane-1", "--workspace", "ws-new", "-U", "--amount", "175"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["resize-pane", "--pane", "pane-2", "--workspace", "ws-new", "-L", "--amount", "133"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
];

const SEVEN = ["top", "r1c1", "r2c1", "r1c2", "r1c3", "r2c2", "r2c3"];

/**
 * Goldens for every ONE-LOWER-ROW console, captured by running this file
 * against the PRE-FIX `operations.ts` (commit 06c6dba). SRD-TRIAGE-MIXED-
 * OBSERVERS §4.3/D4's narrowed shrink branch computes the same amount as the
 * branch it replaces whenever there is exactly one row below the top and no
 * divider between them, as in this model — top-row height plus that row's
 * height is then the whole container, so "current top height minus the
 * target" and "the container's complement of the target minus this pane's
 * height" are the same number — and `applyMiddleRowFraction` issues no call
 * on any spec below, since none of them sets `middleRowFraction`. So these
 * are the pre-fix sequences, asserted byte for byte. (A live divider can move
 * the amount by at most its width; this model has none.)
 */
const GOLDEN_REVIEW_BIG_SHRINK: string[][] = [
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["resize-pane", "--pane", "pane-1", "--workspace", "ws-new", "-U", "--amount", "449"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["resize-pane", "--pane", "pane-2", "--workspace", "ws-new", "-L", "--amount", "133"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
];
const GOLDEN_REVIEW_GROW: string[][] = [
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["resize-pane", "--pane", "pane-0", "--workspace", "ws-new", "-D", "--amount", "151"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["resize-pane", "--pane", "pane-2", "--workspace", "ws-new", "-L", "--amount", "133"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
];
const GOLDEN_OPERATIONS_DEFAULT: string[][] = [
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["resize-pane", "--pane", "pane-0", "--workspace", "ws-new", "-D", "--amount", "158"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
];
const GOLDEN_OPERATIONS_SHRINK: string[][] = [
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["resize-pane", "--pane", "pane-1", "--workspace", "ws-new", "-U", "--amount", "216"],
];

describe("the split-tree model", () => {
  test("matches the live cmux measurement applyBottomWidths' docblock cites (2026-09-13)", async () => {
    const model = new LayoutModel();
    const { client, titleByPane } = fakeCmux(model);
    await createWorkspace(client, GEOM_SPEC, OPTS);

    const p1 = paneIdFor(titleByPane, "gp1");
    const p2 = paneIdFor(titleByPane, "gp2");
    const p3 = paneIdFor(titleByPane, "gp3");

    // Pre-shape the row to 265/176/352, SCALED to this container: the raw
    // numbers summed to 793 on the live 795.33px console, so the ratios they
    // express — not the literal pixels — are what a same-shaped row here
    // should start from.
    const scale = CONTAINER_WIDTH / (265 + 176 + 352);
    const target1 = 265 * scale;
    const target2 = 176 * scale;

    let d = target1 - model.frames().get(p1)!.width;
    if (d > 0) model.resize(p1, "R", d);
    else model.resize(p2, "L", -d);

    d = target2 - model.frames().get(p2)!.width;
    if (d > 0) model.resize(p2, "R", d);
    else model.resize(p3, "L", -d);

    let f = model.frames();
    expect(Math.abs(f.get(p1)!.width - target1)).toBeLessThan(1.5);
    expect(Math.abs(f.get(p2)!.width - target2)).toBeLessThan(1.5);

    // MEASURED live 2026-09-13: `resize-pane --pane obs-t2 -L --amount 30`
    // against 265/176/352 gave 235/186/372 — the tree model's prediction, not
    // the discarded flat-row model's. Reproduce it here, same scale.
    model.resize(p2, "L", 30);
    f = model.frames();
    expect(Math.abs(f.get(p1)!.width - 235 * scale)).toBeLessThan(1.5);
    expect(Math.abs(f.get(p2)!.width - 186 * scale)).toBeLessThan(1.5);
    expect(Math.abs(f.get(p3)!.width - 372 * scale)).toBeLessThan(1.5);
  });
});

describe("applyBottomWidths, through createWorkspace", () => {
  test("review console (one multi-pane row): golden call sequence, unchanged by the generalization", async () => {
    const model = new LayoutModel();
    const { client, calls, titleByPane } = fakeCmux(model);

    await createWorkspace(client, REVIEW_SPEC, OPTS);

    const focusIdx = calls.findIndex((c) => c[0] === "focus-pane");
    expect(focusIdx).toBeGreaterThan(-1);
    expect(calls.slice(focusIdx + 1)).toEqual(GOLDEN_REVIEW_SEQUENCE);

    const widths = ["rev-arch-1", "rev-ctx-1", "rev-lang-1"].map(
      (t) => model.frames().get(paneIdFor(titleByPane, t))!.width,
    );
    expect(Math.max(...widths) - Math.min(...widths)).toBeLessThan(1);
  });

  test("triage console (two full-width observer rows): both settle to thirds", async () => {
    const model = new LayoutModel();
    const { client, titleByPane } = fakeCmux(model);

    await createWorkspace(client, TRIAGE_SPEC, { ...OPTS, workers: SEVEN });

    const f = model.frames();
    const widthOf = (title: string) => f.get(paneIdFor(titleByPane, title))!.width;

    expect(Math.abs(widthOf("top") - CONTAINER_WIDTH)).toBeLessThan(1);
    for (const title of ["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"]) {
      expect(Math.abs(widthOf(title) - CONTAINER_WIDTH / 3)).toBeLessThan(1);
    }
  });

  test("only the upper row miswidthed: it is still corrected", async () => {
    const model = new LayoutModel();
    const { client, titleByPane } = fakeCmux(model, {
      afterBuild: (m) => {
        // Row two is settled to thirds before either correction pass reads
        // geometry; row one is left at the 50/25/25 `new-split` produces.
        const row2 = ["r2c1", "r2c2", "r2c3"].map((t) => paneIdFor(titleByPane, t));
        settleRowWidths(m, row2, 1 / 3);
      },
    });

    await createWorkspace(client, TRIAGE_SPEC, { ...OPTS, workers: SEVEN });

    const f = model.frames();
    for (const title of ["r1c1", "r1c2", "r1c3"]) {
      const width = f.get(paneIdFor(titleByPane, title))!.width;
      expect(Math.abs(width - CONTAINER_WIDTH / 3)).toBeLessThan(1);
    }
  });

  test("rows of unequal height: widths settle to thirds, and the width pass issues no vertical resize", async () => {
    const model = new LayoutModel();
    let row1HeightAfterBuild = 0;
    let row2HeightAfterBuild = 0;
    const { client, calls, titleByPane } = fakeCmux(model, {
      afterBuild: (m) => {
        // Move the row-one/row-two border so the rows differ by >= 100px —
        // "U" on a row-two pane shrinks row one (the `a` side) and grows row
        // two (`b`) by the same amount.
        m.resize(paneIdFor(titleByPane, "r2c1"), "U", 150);
        const f = m.frames();
        row1HeightAfterBuild = f.get(paneIdFor(titleByPane, "r1c1"))!.height;
        row2HeightAfterBuild = f.get(paneIdFor(titleByPane, "r2c1"))!.height;
      },
    });

    // The real spec now: `applyTopFraction` and `applyMiddleRowFraction` both
    // run and will themselves move this border toward thirds — that is
    // exercised by the seven-pane height describe below. What THIS test pins
    // is narrower and still true with both height passes on: the WIDTH pass
    // settles every column to a third regardless of what the height passes
    // did to the rows, and it never itself issues a vertical resize.
    await createWorkspace(client, TRIAGE_SPEC, { ...OPTS, workers: SEVEN });

    expect(row2HeightAfterBuild - row1HeightAfterBuild).toBeGreaterThanOrEqual(100);

    const f = model.frames();
    for (const title of ["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"]) {
      const width = f.get(paneIdFor(titleByPane, title))!.width;
      expect(Math.abs(width - CONTAINER_WIDTH / 3)).toBeLessThan(1);
    }

    // The width pass runs LAST (`createWorkspace`'s own ordering comment), so
    // nothing after its first horizontal resize should be a vertical one —
    // proof from the call log, not just the end state, that
    // `applyBottomWidths` itself never touches a row divider.
    const firstWidthResizeIdx = calls.findIndex(
      (c) => c[0] === "resize-pane" && (c.includes("-L") || c.includes("-R")),
    );
    expect(firstWidthResizeIdx).toBeGreaterThan(-1);
    const verticalAfterFirstWidthResize = calls
      .slice(firstWidthResizeIdx + 1)
      .filter((c) => c[0] === "resize-pane" && (c.includes("-U") || c.includes("-D")));
    expect(verticalAfterFirstWidthResize).toEqual([]);
  });

  test("bottomWidthFraction: null issues no width resize at all", async () => {
    const model = new LayoutModel();
    const { client, calls } = fakeCmux(model);

    await createWorkspace(
      client,
      { ...TRIAGE_SPEC, bottomWidthFraction: null },
      { ...OPTS, workers: SEVEN },
    );

    const widthResizes = calls.filter(
      (c) => c[0] === "resize-pane" && (c.includes("-L") || c.includes("-R")),
    );
    expect(widthResizes).toEqual([]);
  });
});

/**
 * `applyTopFraction` + `applyMiddleRowFraction`, through `createWorkspace`, on
 * the SEVEN-pane triage table — the shape neither pass could settle correctly
 * before SRD-TRIAGE-MIXED-OBSERVERS §4.3/D4: the old shrink branch moved every
 * non-top pane against `containerHeight * (1 - fraction)`, a target that only
 * means what it says with ONE row below the top. With two rows it either
 * over-moved the collator border (a row-one pane) or reached past row one
 * and moved the border BETWEEN the observer rows instead (a row-two pane).
 *
 * Run for BOTH `list-panes` orders the fake can produce, because every
 * computation in both passes is `Math.min`/`Math.max`/`.find`/`.filter` over
 * `y`/`x`/`paneId`, and none of that is entitled to assume creation order.
 */
describe("applyTopFraction + applyMiddleRowFraction, through createWorkspace: the seven-pane table", () => {
  const heightOf = (
    frames: Map<string, { height: number }>,
    titleByPane: Map<string, string>,
    title: string,
  ): number => frames.get(paneIdFor(titleByPane, title))!.height;
  const widthOf = (
    frames: Map<string, { width: number }>,
    titleByPane: Map<string, string>,
    title: string,
  ): number => frames.get(paneIdFor(titleByPane, title))!.width;

  const OBSERVER_TITLES = ["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"];

  /** Asserts the settled end state common to every scenario below. */
  function expectSettled(model: LayoutModel, titleByPane: Map<string, string>): void {
    const f = model.frames();
    expect(Math.abs(heightOf(f, titleByPane, "top") - CONTAINER_HEIGHT * (TRIAGE_TOP_FRACTION as number))).toBeLessThan(1);
    for (const title of OBSERVER_TITLES) {
      expect(Math.abs(heightOf(f, titleByPane, title) - CONTAINER_HEIGHT / 3)).toBeLessThan(1);
      expect(Math.abs(widthOf(f, titleByPane, title) - CONTAINER_WIDTH / 3)).toBeLessThan(1);
    }
  }

  test.each(["creation", "reverse"] as const)(
    "row two taller than row one by >= 100px settles to thirds (list order: %s)",
    async (paneOrder) => {
      const model = new LayoutModel();
      let row1Before = 0;
      let row2Before = 0;
      const { client, titleByPane } = fakeCmux(model, {
        paneOrder,
        afterBuild: (m) => {
          m.resize(paneIdFor(titleByPane, "r2c1"), "U", 150);
          const f = m.frames();
          row1Before = f.get(paneIdFor(titleByPane, "r1c1"))!.height;
          row2Before = f.get(paneIdFor(titleByPane, "r2c1"))!.height;
        },
      });

      await createWorkspace(client, TRIAGE_SPEC, { ...OPTS, workers: SEVEN });

      // The pre-shape actually produced unequal rows.
      expect(row2Before - row1Before).toBeGreaterThanOrEqual(100);

      expectSettled(model, titleByPane);
    },
  );

  test.each(["creation", "reverse"] as const)(
    "row one taller than row two by >= 100px settles to thirds (list order: %s)",
    async (paneOrder) => {
      const model = new LayoutModel();
      let row1Before = 0;
      let row2Before = 0;
      const { client, titleByPane } = fakeCmux(model, {
        paneOrder,
        afterBuild: (m) => {
          m.resize(paneIdFor(titleByPane, "r1c1"), "D", 150);
          const f = m.frames();
          row1Before = f.get(paneIdFor(titleByPane, "r1c1"))!.height;
          row2Before = f.get(paneIdFor(titleByPane, "r2c1"))!.height;
        },
      });

      await createWorkspace(client, TRIAGE_SPEC, { ...OPTS, workers: SEVEN });

      // The pre-shape actually produced unequal rows.
      expect(row1Before - row2Before).toBeGreaterThanOrEqual(100);

      expectSettled(model, titleByPane);
    },
  );

  test.each(["creation", "reverse"] as const)(
    "collator pre-shrunk below a third (GROW branch) with unequal observer rows settles to thirds (list order: %s)",
    async (paneOrder) => {
      const model = new LayoutModel();
      let row1Before = 0;
      let row2Before = 0;
      const { client, titleByPane } = fakeCmux(model, {
        paneOrder,
        afterBuild: (m) => {
          // Shrink the collator well below a third — the top-row pass must
          // GROW it back, with two rows already beneath it.
          m.resize(paneIdFor(titleByPane, "r1c1"), "U", 300);
          // …and still leave the two observer rows unequal, so this scenario
          // also proves the GROW branch does not accidentally depend on the
          // two lower rows starting equal.
          m.resize(paneIdFor(titleByPane, "r2c1"), "U", 150);
          const f = m.frames();
          row1Before = f.get(paneIdFor(titleByPane, "r1c1"))!.height;
          row2Before = f.get(paneIdFor(titleByPane, "r2c1"))!.height;
        },
      });

      await createWorkspace(client, TRIAGE_SPEC, { ...OPTS, workers: SEVEN });

      // The pre-shape actually produced unequal rows.
      expect(row2Before - row1Before).toBeGreaterThanOrEqual(100);

      expectSettled(model, titleByPane);
    },
  );

  test.each(["creation", "reverse"] as const)(
    "the collator shrink moves only the row directly beneath it: no -U names a row-two pane (list order: %s)",
    async (paneOrder) => {
      const model = new LayoutModel();
      const { client, calls, titleByPane } = fakeCmux(model, {
        paneOrder,
        afterBuild: (m) => {
          m.resize(paneIdFor(titleByPane, "r2c1"), "U", 150);
        },
      });

      await createWorkspace(client, TRIAGE_SPEC, { ...OPTS, workers: SEVEN });

      // The collator starts at 526px, so the top pass SHRINKS; row one starts
      // shorter than row two, so the middle pass GROWS row one with `-D`. No
      // pass has a reason to issue `-U` on a row-two pane here. A shrink that
      // reached past row one would move the border BETWEEN the observer rows,
      // and the middle pass would quietly undo it, so the end state alone
      // cannot show it; the call log can. With panes listed in reverse order a
      // row-two pane is the first one such a shrink would visit.
      const rowTwo = new Set(["r2c1", "r2c2", "r2c3"].map((t) => paneIdFor(titleByPane, t)));
      const upOnRowTwo = calls.filter(
        (c) => c[0] === "resize-pane" && c.includes("-U") && rowTwo.has(c[c.indexOf("--pane") + 1]!),
      );
      expect(upOnRowTwo).toEqual([]);
      expectSettled(model, titleByPane);
    },
  );

  test("no issued resize-pane is refused", async () => {
    const model = new LayoutModel();
    const { client, titleByPane } = fakeCmux(model, {
      afterBuild: (m) => {
        // A shape needing correction on every border this console has: the
        // collator shrunk well below a third AND the two observer rows left
        // unequal, so every pass in the chain has something to move.
        m.resize(paneIdFor(titleByPane, "r1c1"), "U", 300);
        m.resize(paneIdFor(titleByPane, "r2c1"), "U", 150);
      },
    });

    // `applyTopFraction`'s own catch would SWALLOW a refused resize — see its
    // docblock — so a passing end state alone would not catch one. The fake
    // never refuses a well-formed resize (see `LayoutModel.resize`), so the
    // only way this pass writes to stderr is a bug that issues a call the
    // fake's model itself rejects (`invalid_state`, or a pane id it does not
    // know). Captured directly rather than via the model's own `ok` field, so
    // the same probe also catches a parse-level refusal.
    const originalWrite = process.stderr.write.bind(process.stderr);
    const written: string[] = [];
    process.stderr.write = ((chunk: unknown) => {
      written.push(String(chunk));
      return true;
    }) as typeof process.stderr.write;
    try {
      await createWorkspace(client, TRIAGE_SPEC, { ...OPTS, workers: SEVEN });
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(written).toEqual([]);
  });

  /**
   * Every `resize-pane` call carries `--workspace`, pinned as an invariant
   * over the FULL call log rather than any one golden sequence — this build
   * exercises all three sizing passes at once (`applyTopFraction`,
   * `applyMiddleRowFraction`, `applyBottomWidths`), so a builder that dropped
   * `--workspace` on any one of them would still be caught here even if a
   * golden sequence elsewhere in this file only ever ran a subset. This is the
   * regression this suite exists to pin: `resizePaneArgv` used to omit
   * `--workspace` entirely, and cmux then resolved the pane against
   * `$CMUX_WORKSPACE_ID` — unset outside cmux — so every one of these calls
   * was failing on the live console the moment the builder omitted it (see
   * `resizePaneArgv`'s own docblock for the 2026-09-15 reproduction).
   */
  test("every resize-pane call is scoped to the workspace being built", async () => {
    const model = new LayoutModel();
    const { client, calls, titleByPane } = fakeCmux(model, {
      afterBuild: (m) => {
        m.resize(paneIdFor(titleByPane, "r1c1"), "U", 300);
        m.resize(paneIdFor(titleByPane, "r2c1"), "U", 150);
      },
    });

    await createWorkspace(client, TRIAGE_SPEC, { ...OPTS, workers: SEVEN });

    const resizeCalls = calls.filter((c) => c[0] === "resize-pane");
    expect(resizeCalls.length).toBeGreaterThan(0);
    for (const c of resizeCalls) {
      const wsIdx = c.indexOf("--workspace");
      expect(wsIdx).toBeGreaterThan(-1);
      expect(c[wsIdx + 1]).toBe("ws-new");
    }
  });
});

/**
 * Every ONE-LOWER-ROW console (`review`, `operations`) keeps its command
 * sequence under SRD-TRIAGE-MIXED-OBSERVERS §4.3/D4's narrowed shrink branch:
 * see `GOLDEN_REVIEW_BIG_SHRINK`'s docblock above for why the two branches
 * agree in this model and why `applyMiddleRowFraction` never issues a call for these
 * specs. This describe pins that with the same golden-call-sequence technique
 * `GOLDEN_REVIEW_SEQUENCE` already used, covering both directions
 * (`applyTopFraction`'s GROW and SHRINK branches) on both consoles.
 */
describe("one-lower-row consoles: command sequences unchanged by the narrowed shrink branch", () => {
  test("review console: default build (existing golden, unchanged)", async () => {
    const model = new LayoutModel();
    const { client, calls, titleByPane } = fakeCmux(model);

    await createWorkspace(client, REVIEW_SPEC, OPTS);

    const focusIdx = calls.findIndex((c) => c[0] === "focus-pane");
    expect(focusIdx).toBeGreaterThan(-1);
    expect(calls.slice(focusIdx + 1)).toEqual(GOLDEN_REVIEW_SEQUENCE);

    const colHeight = model.frames().get(paneIdFor(titleByPane, "col-1"))!.height;
    expect(Math.abs(colHeight - CONTAINER_HEIGHT * (REVIEW_TOP_FRACTION as number))).toBeLessThan(1);
  });

  test("review console: collator pre-grown to ~800px (a bigger SHRINK)", async () => {
    const model = new LayoutModel();
    const { client, calls, titleByPane } = fakeCmux(model, {
      afterBuild: (m) => {
        const col = paneIdFor(titleByPane, "col-1");
        const current = m.frames().get(col)!.height;
        m.resize(col, "D", 800 - current);
      },
    });

    await createWorkspace(client, REVIEW_SPEC, OPTS);

    const focusIdx = calls.findIndex((c) => c[0] === "focus-pane");
    expect(focusIdx).toBeGreaterThan(-1);
    expect(calls.slice(focusIdx + 1)).toEqual(GOLDEN_REVIEW_BIG_SHRINK);

    const colHeight = model.frames().get(paneIdFor(titleByPane, "col-1"))!.height;
    expect(Math.abs(colHeight - CONTAINER_HEIGHT * (REVIEW_TOP_FRACTION as number))).toBeLessThan(1);
  });

  test("review console: collator pre-shrunk to ~200px (GROW)", async () => {
    const model = new LayoutModel();
    const { client, calls, titleByPane } = fakeCmux(model, {
      afterBuild: (m) => {
        const col = paneIdFor(titleByPane, "col-1");
        const bottom = paneIdFor(titleByPane, "rev-arch-1");
        const current = m.frames().get(col)!.height;
        m.resize(bottom, "U", current - 200);
      },
    });

    await createWorkspace(client, REVIEW_SPEC, OPTS);

    const focusIdx = calls.findIndex((c) => c[0] === "focus-pane");
    expect(focusIdx).toBeGreaterThan(-1);
    expect(calls.slice(focusIdx + 1)).toEqual(GOLDEN_REVIEW_GROW);

    const colHeight = model.frames().get(paneIdFor(titleByPane, "col-1"))!.height;
    expect(Math.abs(colHeight - CONTAINER_HEIGHT * (REVIEW_TOP_FRACTION as number))).toBeLessThan(1);
  });

  test("operations console: default build (0.65 top fraction, a GROW from 526px)", async () => {
    const model = new LayoutModel();
    const { client, calls } = fakeCmux(model);

    // OPTS carries no `workers`, so this also checks that the default
    // (`DEFAULT_OPERATIONS_WORKERS`) is what the plan falls back to.
    await createWorkspace(client, OPERATIONS_SPEC, OPTS);

    const focusIdx = calls.findIndex((c) => c[0] === "focus-pane");
    expect(focusIdx).toBeGreaterThan(-1);
    expect(calls.slice(focusIdx + 1)).toEqual(GOLDEN_OPERATIONS_DEFAULT);

    const topHeight = model.frames().get(topRowPaneId(model))!.height;
    expect(Math.abs(topHeight - CONTAINER_HEIGHT * OPERATIONS_TOP_FRACTION)).toBeLessThan(1);
  });

  test("operations console: top row pre-grown to ~900px (SHRINK, -U on the monitor)", async () => {
    const model = new LayoutModel();
    const { client, calls } = fakeCmux(model, {
      afterBuild: (m) => {
        const topPane = topRowPaneId(m);
        const current = m.frames().get(topPane)!.height;
        m.resize(topPane, "D", 900 - current);
      },
    });

    await createWorkspace(client, OPERATIONS_SPEC, OPTS);

    const focusIdx = calls.findIndex((c) => c[0] === "focus-pane");
    expect(focusIdx).toBeGreaterThan(-1);
    expect(calls.slice(focusIdx + 1)).toEqual(GOLDEN_OPERATIONS_SHRINK);

    const topHeight = model.frames().get(topRowPaneId(model))!.height;
    expect(Math.abs(topHeight - CONTAINER_HEIGHT * OPERATIONS_TOP_FRACTION)).toBeLessThan(1);
  });
});

/**
 * The gate itself: `middleRowFraction` is set on exactly one spec.
 *
 * The BEHAVIOURAL pin is the golden sequences above (a gate set on `review`
 * or `operations` would add a `list-panes` neither golden has) and the
 * seven-pane describe (a gate absent on `triage` would leave the two observer
 * rows unsettled) — this test only pins the DATA the gate reads, so a spec
 * edited to carry the wrong value, or the right value on the wrong spec,
 * reddens here before it ever reaches a behavioural probe.
 */
describe("middleRowFraction: the gate", () => {
  test("only triage sets it, and only to TRIAGE_OBSERVER_ROW_FRACTION", () => {
    expect(OPERATIONS_SPEC.middleRowFraction ?? null).toBeNull();
    expect(DEVELOPMENT_SPEC.middleRowFraction ?? null).toBeNull();
    expect(REVIEW_SPEC.middleRowFraction ?? null).toBeNull();
    expect(TRIAGE_SPEC.middleRowFraction).toBe(TRIAGE_OBSERVER_ROW_FRACTION);
    expect(TRIAGE_SPEC.middleRowFraction).toBe(1 / 2);
  });
});
