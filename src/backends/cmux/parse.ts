/**
 * Parsers for cmux CLI output — pure functions, no process spawning.
 *
 * Everything here was shaped by probing the installed cmux 0.64.20, not by its
 * documentation, because the two disagree in ways that would each have been a
 * runtime failure:
 *
 *  - `workspace create` WITHOUT `--json` prints `OK workspace:6`, not the JSON
 *    object the design docs imply. The client always passes `--json`.
 *  - With `--id-format uuids` the JSON KEY NAMES change: `workspace_ref`
 *    becomes `workspace_id`, `surface_ref` becomes `surface_id`, a pane's
 *    `ref` becomes `id`. A parser written against one spelling silently reads
 *    `undefined` from the other, so every accessor below tries both.
 *
 * Malformed output THROWS rather than reading as "absent": a cmux speaking an
 * unexpected dialect must surface as a loud parse failure, not as "workspace
 * not found" that sends the caller off to create a duplicate.
 */

export class CmuxParseError extends Error {
  constructor(what: string, sample: string) {
    // Truncate the sample: a wedged cmux could emit megabytes, and an error
    // message is not the place to buffer them.
    super(`cmux: could not parse ${what}: ${sample.slice(0, 256)}`);
    this.name = "CmuxParseError";
  }
}

/**
 * A pane in this backend is addressed by its pane id, the id of the terminal
 * surface inside it, AND the id of the workspace that owns it, because cmux
 * splits the verbs three ways: `focus-pane` wants a pane scoped to a workspace
 * context; `read-screen`, `send` and `send-key` want a surface alone;
 * `respawn-pane` and `rename-tab` want a surface scoped to a workspace
 * context — with neither `--workspace` nor `$CMUX_WORKSPACE_ID` set, surface
 * resolution for those two verbs fails even on a surface id `new-split` just
 * returned, probed live against 0.64.22 on 2026-08-18 (see `respawnPaneArgv`),
 * and `focus-pane` resolves against the CALLER'S workspace when the flag is
 * omitted inside cmux (2026-09-13, see `focusPaneArgv`). The seam's `PaneRef` carries one
 * opaque string, so all three ids travel composed in it. A space is a safe
 * separator: no id cmux emits (UUID or `kind:N` ref) contains one.
 */
export function composePaneId(paneId: string, surfaceId: string, workspaceId: string): string {
  for (const [what, v] of [
    ["pane id", paneId],
    ["surface id", surfaceId],
    ["workspace id", workspaceId],
  ] as const) {
    if (v === "" || v.includes(" ")) {
      throw new CmuxParseError(`${what} (empty or embedded space)`, `${paneId} ${surfaceId} ${workspaceId}`);
    }
  }
  return `${paneId} ${surfaceId} ${workspaceId}`;
}

/**
 * Split a composed pane id into as much as it actually carries.
 *
 * THREE ARITIES ARE LEGAL, because three different producers write this field
 * and each knows a different amount:
 *
 * | fields | producer | reaches |
 * |---|---|---|
 * | `<pane> <surface> <workspace>` | `createPane` | every verb |
 * | `<pane> <surface>` | a pifleet build predating the `--workspace` fix, persisted in `presentation.json` | `send`, `send-key`, `read-screen` — not `focus-pane`, `respawn-pane` or `rename-tab` |
 * | `<surface>` | `up --attach-here`, out of `CMUX_SURFACE_ENV` | `send`, `send-key`, `read-screen` |
 *
 * Missing fields are reported as `null` rather than fabricated, so the verb
 * that needs one can refuse BY NAME at its own call site — `attachViewer` for
 * a null workspace, `focus` for a null pane or a null workspace. That disposition is the point:
 * an opaque parse failure two layers down is what made the 1-field case
 * silently break every staged dispatch to a `tui` worker, since `sendText`
 * wanted only the surface the string already was.
 */
export function splitPaneId(composed: string): {
  paneId: string | null;
  surfaceId: string;
  workspaceId: string | null;
} {
  const parts = composed.split(" ");
  if (parts.length < 1 || parts.length > 3 || parts.some((p) => p === "")) {
    throw new CmuxParseError("composed pane id", composed);
  }
  /*
   * ONE FIELD IS A BARE SURFACE ID, and refusing it was the defect.
   *
   * `up --attach-here` adopts the surface out of `CMUX_SURFACE_ENV`
   * (`attended/adopt.ts`), which cmux sets to a surface UUID and nothing else.
   * That value reached here and was rejected as an unparseable "composed pane
   * id" — so on every console built with `--attach-here`, `sendText` threw
   * before it could type, and EVERY staged dispatch to a `tui` worker
   * deferred its trigger. Measured 2026-09-04, run
   * `2026-09-04T02-28-00Z-e07e`:
   *
   *   CmuxParseError: cmux: could not parse composed pane id:
   *   5C9D22AC-543A-4B1A-A2E6-6555573DB407
   *
   * That id is the worker's surface, and `sendText` wanted only the surface.
   * The parser was demanding fields its caller was about to discard.
   *
   * So the arity says which verbs are reachable, and the verbs that are not
   * refuse BY NAME at their own call site rather than here — the same
   * disposition the 2-field legacy case already gets. One field is enough for
   * `send`, `send-key` and `read-screen`; `focus-pane` additionally needs the
   * pane AND the workspace, and `respawn-pane`/`rename-tab` additionally need
   * the workspace.
   */
  if (parts.length === 1) {
    return { paneId: null, surfaceId: parts[0]!, workspaceId: null };
  }
  return { paneId: parts[0]!, surfaceId: parts[1]!, workspaceId: parts[2] ?? null };
}

function asObject(what: string, raw: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new CmuxParseError(what, raw);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new CmuxParseError(what, raw);
  }
  return parsed as Record<string, unknown>;
}

/** First present string among the given keys — the uuid/ref dual-spelling accessor. */
function pick(o: Record<string, unknown>, keys: string[]): string | null {
  for (const k of keys) {
    const v = o[k];
    if (typeof v === "string" && v.length > 0) return v;
  }
  return null;
}

export interface WorkspaceCreated {
  workspaceId: string;
  /** The initial terminal surface the new workspace opens with. */
  surfaceId: string;
  windowId: string | null;
}

/**
 * `workspace create --json --id-format uuids` →
 * `{workspace_id, surface_id, window_id, group_id}` (probed live; the
 * `*_ref` spellings appear when `--id-format` is omitted).
 */
export function parseWorkspaceCreate(stdout: string): WorkspaceCreated {
  const o = asObject("workspace create output", stdout);
  const workspaceId = pick(o, ["workspace_id", "workspace_ref"]);
  const surfaceId = pick(o, ["surface_id", "surface_ref"]);
  if (workspaceId === null || surfaceId === null) {
    throw new CmuxParseError("workspace create output (missing ids)", stdout);
  }
  return { workspaceId, surfaceId, windowId: pick(o, ["window_id", "window_ref"]) };
}

export interface WorkspaceListed {
  id: string;
  /** `custom_title` round-trips `--name` (SRD §4.1); `title` is derived and unstable. */
  customTitle: string | null;
  /**
   * `custom_color` — `#rrggbb`, or `null` when nobody ever set one.
   *
   * Read so `--recreate` can put a console's colour back. Closing a workspace
   * takes the colour with it and the rebuilt console is a DIFFERENT workspace,
   * which cmux has no reason to colour; capturing it before the close is the
   * only moment it can still be read.
   *
   * `null` is the ordinary case and means *leave it uncoloured* — never *apply
   * a default*. A console that never had a colour must not acquire one from a
   * rebuild.
   */
  customColor: string | null;
}

/** `workspace list --json --id-format uuids` → `{window_id, workspaces:[{id, custom_title, …}]}`. */
export function parseWorkspaceList(stdout: string): WorkspaceListed[] {
  const o = asObject("workspace list output", stdout);
  const list = o["workspaces"];
  if (!Array.isArray(list)) {
    throw new CmuxParseError("workspace list output (no workspaces array)", stdout);
  }
  const out: WorkspaceListed[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const id = pick(e, ["id", "ref"]);
    if (id === null) continue;
    const title = e["custom_title"];
    const color = e["custom_color"];
    out.push({
      id,
      customTitle: typeof title === "string" ? title : null,
      // Empty string reads as absent: cmux emits `null` for "no colour", and a
      // blank would otherwise become a `--color ""` on the rebuild.
      customColor: typeof color === "string" && color.length > 0 ? color : null,
    });
  }
  return out;
}

/**
 * Find a workspace previously created under `--name`.
 *
 * Matched on `custom_title` ONLY — `title` falls back to the directory name
 * for unnamed workspaces, so matching it would adopt any workspace whose cwd
 * happens to be named like the fleet.
 */
export function findWorkspaceByTitle(list: WorkspaceListed[], name: string): WorkspaceListed | null {
  return list.find((w) => w.customTitle === name) ?? null;
}

/** One sidebar group, from `workspace group list --json`. */
export interface WorkspaceGroupListed {
  /** A `workspace_group:N` ref, or a UUID under `--id-format uuids`. */
  id: string;
  /** The name the SIDEBAR shows — the one field no other verb prints. */
  name: string | null;
}

/**
 * `workspace group list --json` → `{groups:[{ref|id, name, …}]}`.
 *
 * A SEPARATE parser from {@link parseWorkspaceList}, because a group is not a
 * workspace: it OWNS one — its anchor — and the anchor is what `workspace list`
 * reports. Reusing that parser here would answer with the anchor's
 * `custom_title` (`Group 1`) when the caller asked for the group's name
 * (`pi-fleet`), which is a wrong answer that looks like a right one.
 */
export function parseWorkspaceGroupList(stdout: string): WorkspaceGroupListed[] {
  const o = asObject("workspace group list output", stdout);
  const list = o["groups"];
  if (!Array.isArray(list)) {
    throw new CmuxParseError("workspace group list output (no groups array)", stdout);
  }
  const out: WorkspaceGroupListed[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    // Both spellings, for the same reason every accessor in this file tries
    // both: `--id-format uuids` renames `ref` to `id`.
    const id = pick(e, ["id", "ref"]);
    if (id === null) continue;
    const name = e["name"];
    out.push({ id, name: typeof name === "string" ? name : null });
  }
  return out;
}

/**
 * Find a sidebar group by the name the operator actually sees.
 *
 * Matched on `name` ONLY, and resolved on every rebuild rather than stored: a
 * `workspace_group:N` ref renumbers as groups move, and a UUID belongs to one
 * machine. Neither can be written down in a tracked repository, and a name can.
 */
export function findWorkspaceGroupByName(
  list: WorkspaceGroupListed[],
  name: string,
): WorkspaceGroupListed | null {
  return list.find((g) => g.name === name) ?? null;
}

export interface PaneListed {
  paneId: string;
  /** The surface a viewer/`read-screen` should address; panes hold ≥1 surface. */
  selectedSurfaceId: string | null;
  index: number;
}

/** `list-panes --json --id-format uuids` → `{panes:[{id, selected_surface_id, index, …}]}`. */
export function parseListPanes(stdout: string): PaneListed[] {
  const o = asObject("list-panes output", stdout);
  const list = o["panes"];
  if (!Array.isArray(list)) {
    throw new CmuxParseError("list-panes output (no panes array)", stdout);
  }
  const out: PaneListed[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const paneId = pick(e, ["id", "ref"]);
    if (paneId === null) continue;
    const idx = e["index"];
    out.push({
      paneId,
      selectedSurfaceId: pick(e, ["selected_surface_id", "selected_surface_ref"]),
      index: typeof idx === "number" ? idx : out.length,
    });
  }
  return out;
}

/** One surface inside a pane, as `list-pane-surfaces --json` reports it. */
export interface PaneSurface {
  surfaceId: string;
  /** The `rename-tab` title. For a console pane this is the worker id. */
  title: string | null;
  selected: boolean;
}

/**
 * `list-pane-surfaces --json --id-format uuids` → `{surfaces:[{id, title, …}]}`.
 *
 * A surface with NO title is kept, with `title: null`, rather than dropped. A
 * pane whose title never landed is the case a caller most needs to see: it is
 * indistinguishable from "no such worker" if it is silently filtered out here,
 * and the two want opposite responses — one is a console to rebuild, the other
 * is a typo.
 */
export function parsePaneSurfaces(stdout: string): PaneSurface[] {
  const o = asObject("list-pane-surfaces output", stdout);
  const list = o["surfaces"];
  if (!Array.isArray(list)) {
    throw new CmuxParseError("list-pane-surfaces output (no surfaces array)", stdout);
  }
  const out: PaneSurface[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const surfaceId = pick(e, ["id", "ref"]);
    if (surfaceId === null) continue;
    const title = e["title"];
    out.push({
      surfaceId,
      title: typeof title === "string" && title !== "" ? title : null,
      selected: e["selected"] === true,
    });
  }
  return out;
}

/**
 * One pane's BOX, in the pixel space `list-panes --json` reports.
 *
 * ## The horizontal keys, added 2026-09-13, and why they are not optional
 *
 * This was `{paneId, y, height}` while every console was a 2x2 or a pair of
 * rows: `new-split` halves, so equal columns came for free and nothing ever
 * needed to know where a pane STARTED. The triage console's observer row is the
 * first layout in this repository with THREE panes side by side, and thirds are
 * not reachable by halving at any depth — so a horizontal correction has to be
 * computed, and computing one needs `x` to order the row and `width` to size it.
 *
 * A pane is admitted below only when ALL FOUR numbers are numbers. That couples
 * the vertical pass to the horizontal keys, which is a real cost and is stated
 * rather than hidden: a cmux that reported `y`/`height` and no `x`/`width` would
 * now drop every pane, and {@link parsePaneGeometry}'s caller would take its
 * "nothing to correct" path and leave the layout as split. The alternative —
 * defaulting the missing ones — is worse, because a default is a number the
 * arithmetic cannot distinguish from a measurement, and the resize it produces
 * would be confidently wrong rather than absent.
 *
 * MEASURED against the installed cmux 0.64.x on 2026-09-13, reading the live
 * triage workspace: `pixel_frame` carries `x`, `y`, `width` and `height`, and
 * `container_frame` carries `height` and `width`. Four panes, all four keys
 * present on every one.
 */
export interface PaneGeometry {
  paneId: string;
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * `list-panes --json` → the container's box plus each pane's box.
 *
 * Separate from {@link parseListPanes} because it needs fields that call does
 * not: identity is enough to focus a pane, and nothing but layout wants pixels.
 *
 * `container_frame` is a SIZE and not a rectangle — it reports `height` and
 * `width` with no origin, while each pane's `x`/`y` are absolute and carry the
 * window's own offsets (measured: a top pane at `y: 28` under a 1052-high
 * container, and a left edge at `x: 264.67` beside a sidebar). So a pane's
 * position is only ever meaningful RELATIVE to its siblings — which is why the
 * callers group rows by comparing `y` between panes rather than against zero,
 * and order a row by comparing `x` the same way.
 */
export function parsePaneGeometry(stdout: string): {
  containerHeight: number;
  containerWidth: number;
  panes: PaneGeometry[];
} {
  const o = asObject("list-panes output", stdout);
  const frame = o["container_frame"];
  const list = o["panes"];
  if (typeof frame !== "object" || frame === null || !Array.isArray(list)) {
    throw new CmuxParseError("list-panes output (no container_frame or panes)", stdout);
  }
  const h = (frame as Record<string, unknown>)["height"];
  if (typeof h !== "number") {
    throw new CmuxParseError("list-panes output (container_frame has no height)", stdout);
  }
  const w = (frame as Record<string, unknown>)["width"];
  if (typeof w !== "number") {
    throw new CmuxParseError("list-panes output (container_frame has no width)", stdout);
  }
  const panes: PaneGeometry[] = [];
  for (const entry of list) {
    if (typeof entry !== "object" || entry === null) continue;
    const e = entry as Record<string, unknown>;
    const paneId = pick(e, ["id", "ref"]);
    const box = e["pixel_frame"];
    if (paneId === null || typeof box !== "object" || box === null) continue;
    const b = box as Record<string, unknown>;
    // All four, for the reason {@link PaneGeometry} states: a partial box is
    // dropped rather than completed with a default the arithmetic would trust.
    if (
      typeof b["x"] !== "number" ||
      typeof b["y"] !== "number" ||
      typeof b["width"] !== "number" ||
      typeof b["height"] !== "number"
    ) {
      continue;
    }
    panes.push({ paneId, x: b["x"], y: b["y"], width: b["width"], height: b["height"] });
  }
  return { containerHeight: h, containerWidth: w, panes };
}

export interface SplitCreated {
  paneId: string;
  surfaceId: string;
}

/** `new-split <dir> --json` → `{pane_id/pane_ref, surface_id/surface_ref, type, …}`. */
export function parseNewSplit(stdout: string): SplitCreated {
  const o = asObject("new-split output", stdout);
  const paneId = pick(o, ["pane_id", "pane_ref"]);
  const surfaceId = pick(o, ["surface_id", "surface_ref"]);
  if (paneId === null || surfaceId === null) {
    throw new CmuxParseError("new-split output (missing ids)", stdout);
  }
  return { paneId, surfaceId };
}

/** `capabilities --json` → `{access_mode, methods:[…]}` (probed: 255 methods on 0.64.20). */
export function parseAccessMode(stdout: string): string {
  const o = asObject("capabilities output", stdout);
  const mode = o["access_mode"];
  if (typeof mode !== "string" || mode.length === 0) {
    throw new CmuxParseError("capabilities output (no access_mode)", stdout);
  }
  return mode;
}

/**
 * Shell-quote one argv for a `sh` script.
 *
 * The viewer launch line is WRITTEN TO A SCRIPT and the script path is what
 * reaches cmux, because `--command`-style text is shell-injected — typed into
 * an interactive shell — not exec'd (SRD §4.1). Interpolating config-derived
 * strings into that typed line is command injection by construction; a script
 * this module quotes itself is not. Single-quote wrapping with the `'"'"'`
 * splice is the one POSIX-sh quoting scheme with no other metacharacters.
 */
export function shellQuote(argv: string[]): string {
  return argv.map((a) => `'${a.replaceAll("'", `'"'"'`)}'`).join(" ");
}
