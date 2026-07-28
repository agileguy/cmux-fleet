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
 * A pane in this backend is addressed by BOTH its pane id and the id of the
 * terminal surface inside it, because cmux splits the verbs across the two:
 * `focus-pane` wants a pane, while `respawn-pane`, `read-screen`, `send`,
 * `send-key` and `rename-tab` all want a surface. The seam's `PaneRef` carries
 * one opaque string, so the two UUIDs travel composed in it. A space is a safe
 * separator: UUIDs never contain one.
 */
export function composePaneId(paneId: string, surfaceId: string): string {
  if (paneId.includes(" ") || surfaceId.includes(" ")) {
    throw new CmuxParseError("pane/surface id (embedded space)", `${paneId} ${surfaceId}`);
  }
  return `${paneId} ${surfaceId}`;
}

export function splitPaneId(composed: string): { paneId: string; surfaceId: string } {
  const parts = composed.split(" ");
  if (parts.length !== 2 || parts[0] === "" || parts[1] === "") {
    throw new CmuxParseError("composed pane id", composed);
  }
  return { paneId: parts[0]!, surfaceId: parts[1]! };
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
    out.push({ id, customTitle: typeof title === "string" ? title : null });
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
