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
import { collatorOverRowPanes } from "../../src/backends/cmux/operations-plan.ts";
import {
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

  /** The `list-panes --json --id-format uuids` body, panes in creation order. */
  listPanesJson(): unknown {
    const boxes = computeBoxes(this.root, OFFSET_X, OFFSET_Y, CONTAINER_WIDTH, CONTAINER_HEIGHT);
    const panes = this.paneOrder.map((paneId, i) => {
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
 * respawned — and before either correction pass reads geometry — so a test can
 * pre-shape the layout the two passes will see.
 */
function fakeCmux(model: LayoutModel, opts: { afterBuild?: (model: LayoutModel) => void } = {}): FakeCmux {
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
          return ok(JSON.stringify(model.listPanesJson()));
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

/** Exactly `applyBottomWidths`' 9-call sequence, captured against the UNMODIFIED pass on `REVIEW_SPEC`. */
const GOLDEN_REVIEW_SEQUENCE: string[][] = [
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["resize-pane", "--pane", "pane-1", "-U", "--amount", "175"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
  ["resize-pane", "--pane", "pane-2", "-L", "--amount", "133"],
  ["list-panes", "--workspace", "ws-new", "--json", "--id-format", "uuids"],
];

const SEVEN = ["top", "r1c1", "r2c1", "r1c2", "r1c3", "r2c2", "r2c3"];

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

    // Height is not under test here: topFraction is overridden to null so
    // applyTopFraction is a no-op and only the width pass runs.
    await createWorkspace(client, { ...TRIAGE_SPEC, topFraction: null }, { ...OPTS, workers: SEVEN });

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

    await createWorkspace(client, { ...TRIAGE_SPEC, topFraction: null }, { ...OPTS, workers: SEVEN });

    const f = model.frames();
    for (const title of ["r1c1", "r1c2", "r1c3"]) {
      const width = f.get(paneIdFor(titleByPane, title))!.width;
      expect(Math.abs(width - CONTAINER_WIDTH / 3)).toBeLessThan(1);
    }
  });

  test("rows of unequal height: widths still settle to thirds, heights are untouched", async () => {
    const model = new LayoutModel();
    let row1HeightAfterBuild = 0;
    let row2HeightAfterBuild = 0;
    const { client, titleByPane } = fakeCmux(model, {
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

    await createWorkspace(client, { ...TRIAGE_SPEC, topFraction: null }, { ...OPTS, workers: SEVEN });

    expect(row2HeightAfterBuild - row1HeightAfterBuild).toBeGreaterThanOrEqual(100);

    const f = model.frames();
    for (const title of ["r1c1", "r1c2", "r1c3", "r2c1", "r2c2", "r2c3"]) {
      const width = f.get(paneIdFor(titleByPane, title))!.width;
      expect(Math.abs(width - CONTAINER_WIDTH / 3)).toBeLessThan(1);
    }
    // Widths only — applyBottomWidths must not have moved the row divider.
    expect(f.get(paneIdFor(titleByPane, "r1c1"))!.height).toBeCloseTo(row1HeightAfterBuild, 5);
    expect(f.get(paneIdFor(titleByPane, "r2c1"))!.height).toBeCloseTo(row2HeightAfterBuild, 5);
  });

  test("bottomWidthFraction: null issues no width resize at all", async () => {
    const model = new LayoutModel();
    const { client, calls } = fakeCmux(model);

    await createWorkspace(
      client,
      { ...TRIAGE_SPEC, topFraction: null, bottomWidthFraction: null },
      { ...OPTS, workers: SEVEN },
    );

    const widthResizes = calls.filter(
      (c) => c[0] === "resize-pane" && (c.includes("-L") || c.includes("-R")),
    );
    expect(widthResizes).toEqual([]);
  });
});
