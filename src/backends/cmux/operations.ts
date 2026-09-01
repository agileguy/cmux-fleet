/**
 * Building the `operations` workspace in a live cmux, and — first — declining
 * to build a second one.
 *
 * ## The idempotency rule
 *
 * `ensureOperations` looks for a workspace whose `custom_title` is exactly
 * {@link OPERATIONS_WORKSPACE} and, finding one, CHANGES NOTHING. It does not
 * re-run `up`, does not re-issue the pane commands, and does not close and
 * rebuild. That is the whole point of the guard: this console holds a live
 * ticketing container and a shell an operator may have typed into, and
 * "refresh it" and "destroy it" are the same operation from the outside.
 *
 * Matching is on `custom_title` via `findWorkspaceByTitle`, which is EXACT.
 * A substring or prefix match would adopt `operations-old` or `my-operations`
 * as this workspace and then split panes into somebody else's window.
 *
 * ## Where this lives
 *
 * Under `src/backends/cmux/` for the reason `operations-plan.ts` records:
 * ISC-137 keeps every cmux import in this one directory, and this file is
 * nothing but cmux calls.
 *
 * ## Why an injected client
 *
 * `CmuxClient` takes an `Exec`. Everything below therefore runs in the unit
 * suite against a scripted fake with no cmux, no GUI and no containers, which
 * is the only way the ORDER of these calls gets re-checked on every run —
 * and the order is the part that breaks. A pane is created by splitting off
 * the previous surface, so a `respawn-pane` issued against the wrong id lands
 * a command in the wrong pane and looks, on screen, like a pane that simply
 * did not start.
 */

import {
  CmuxClient,
  assertCmuxValue,
  focusPaneArgv,
  listPanesArgv,
  newSplitArgv,
  pingArgv,
  renameTabArgv,
  resizePaneArgv,
  respawnPaneArgv,
  workspaceCloseArgv,
  workspaceCreateArgv,
  workspaceListArgv,
} from "./client.ts";
import {
  findWorkspaceByTitle,
  parseListPanes,
  parseNewSplit,
  parsePaneGeometry,
  parseWorkspaceCreate,
  parseWorkspaceList,
  type PaneListed,
} from "./parse.ts";
import {
  DEVELOPMENT_TOP_FRACTION,
  DEVELOPMENT_WORKSPACE,
  OPERATIONS_TOP_FRACTION,
  OPERATIONS_WORKSPACE,
  developmentPanes,
  operationsPanes,
  type OperationsPane,
  type OperationsPlanOptions,
} from "./operations-plan.ts";

/**
 * Everything that differs between one standing console and another.
 *
 * The BUILDER below is identical for both — create a workspace, consume its
 * initial surface, split the rest off in the directions the plan names, rename,
 * respawn, focus pane 1. Only three things vary, and they are exactly these
 * three. Adding a fourth console is then a value in this file rather than a
 * second copy of `createWorkspace`, which is the copy that would drift: the
 * BUILD-FIRST-CLOSE-SECOND order below is a measured lesson, and a second
 * builder is a second place to get it backwards.
 */
export interface WorkspaceSpec {
  /** `--name`, and the exact `custom_title` adoption matches on. */
  readonly name: string;
  /** The plan. */
  readonly panes: (opts: OperationsPlanOptions) => OperationsPane[];
  /**
   * Fraction of the height the TOP row gets, or `null` to leave the halves
   * `new-split` produces alone. See {@link DEVELOPMENT_TOP_FRACTION} for why a
   * console of equal panes says `null` rather than `1/2`.
   */
  readonly topFraction: number | null;
}

/** The day-to-day console: one agent pair on top, status and git below. */
export const OPERATIONS_SPEC: WorkspaceSpec = {
  name: OPERATIONS_WORKSPACE,
  panes: operationsPanes,
  topFraction: OPERATIONS_TOP_FRACTION,
};

/** The four-agent console: two engineers on top, tester and reviewer below. */
export const DEVELOPMENT_SPEC: WorkspaceSpec = {
  name: DEVELOPMENT_WORKSPACE,
  panes: developmentPanes,
  topFraction: DEVELOPMENT_TOP_FRACTION,
};

/**
 * `select-workspace <id>` — built here rather than in `client.ts` because the
 * fleet backend has never needed it, and a builder added to that module would
 * be a new public surface on the file whose argv the backend suite pins.
 * `assertCmuxValue` is imported rather than re-implemented so the flag-injection
 * guard is the same one every other verb gets.
 */
export function selectWorkspaceArgv(workspaceId: string): string[] {
  assertCmuxValue("workspace id", workspaceId);
  return ["select-workspace", "--workspace", workspaceId];
}

/**
 * Which pane is showing a given surface.
 *
 * Exported and pure so the "pane 1 gets focus" rule is testable without a
 * cmux. Returns null rather than guessing: focusing the WRONG pane is worse
 * than focusing none, because a wrong focus looks deliberate and a missing one
 * is one keystroke from correct.
 */
export function paneHoldingSurface(panes: PaneListed[], surfaceId: string): string | null {
  return panes.find((p) => p.selectedSurfaceId === surfaceId)?.paneId ?? null;
}

export interface EnsureResult {
  /** False when an `operations` workspace was already there and was left alone. */
  readonly created: boolean;
  readonly workspaceId: string;
}

/**
 * Is a cmux listening at all?
 *
 * Separated from the work below because "no cmux" is not a failure of this
 * script — it is a machine that cannot present the layout, and the caller
 * reports it as `EXIT.BACKEND_UNAVAILABLE` with a named diagnosis rather than
 * as a stack trace. Measured 2026-08-30: with the app closed, every verb fails
 * identically with `Connection refused` on
 * `~/.local/state/cmux/cmux.sock`, so probing once up front is what turns
 * eight identical errors into one sentence.
 */
export async function cmuxReachable(client: CmuxClient): Promise<boolean> {
  const r = await client.run(pingArgv());
  return r.code === 0;
}

/** The existing workspace with this exact `custom_title`, or null. */
export async function findWorkspace(client: CmuxClient, name: string): Promise<string | null> {
  const list = parseWorkspaceList(await client.runOk(workspaceListArgv()));
  return findWorkspaceByTitle(list, name)?.id ?? null;
}

/** The existing `operations` workspace, or null. */
export async function findOperations(client: CmuxClient): Promise<string | null> {
  return findWorkspace(client, OPERATIONS_WORKSPACE);
}

/**
 * Create the workspace and its three panes, in order.
 *
 * The first pane CONSUMES the surface `workspace create` opens with — leaving
 * it as a stray idle shell and splitting three more off it would give four
 * panes, one of them empty. Each later pane is split off the PREVIOUS one, in
 * the direction that pane's plan names; the directions are a property of the
 * layout and live in `operations-plan.ts`, not here.
 */
export async function createWorkspace(
  client: CmuxClient,
  spec: WorkspaceSpec,
  opts: OperationsPlanOptions,
): Promise<EnsureResult> {
  const panes = spec.panes(opts);

  // `--cwd` is the INVOCATION directory: panes 2 and 3 are about where the
  // operator is working, not about where this repository happens to live.
  const created = parseWorkspaceCreate(
    await client.runOk(workspaceCreateArgv(spec.name, opts.watchDir)),
  );
  const wsId = created.workspaceId;

  let anchor = created.surfaceId;
  let firstPaneId: string | null = null;
  // Every pane's surface, by index, so a pane can name an EARLIER anchor than
  // the one it happens to follow. A 2x2 needs exactly that: the bottom-right
  // pane splits off the top-right, not off the bottom-left it was created
  // after. Without this the fourth split stacks a third row in the left column
  // and the layout silently comes out as 3+1 rather than 2+2.
  const surfaces: string[] = [];

  for (const pane of panes) {
    let surfaceId: string;

    if (pane.split === null) {
      surfaceId = created.surfaceId;
    } else {
      const from = pane.splitFrom === undefined ? anchor : surfaces[pane.splitFrom];
      if (from === undefined) {
        // A plan naming an anchor that does not exist yet is a programming
        // error in the plan, not a cmux failure — say so here rather than
        // letting `new-split` refuse an undefined surface id.
        throw new Error(
          `${spec.name}: pane '${pane.title}' names splitFrom ${String(pane.splitFrom)}, ` +
            `which is not an earlier pane`,
        );
      }
      const split = parseNewSplit(await client.runOk(newSplitArgv(wsId, from, pane.split)));
      surfaceId = split.surfaceId;
    }
    surfaces.push(surfaceId);

    // Rename BEFORE respawning. `respawn-pane` restarts the surface's shell,
    // and a title set on a surface that is about to be replaced is a title
    // that may not survive; this order is the one the fleet backend uses.
    await client.runOk(renameTabArgv(wsId, surfaceId, pane.title));
    await client.runOk(respawnPaneArgv(wsId, surfaceId, pane.command));

    anchor = surfaceId;
  }

  // Bring the workspace forward, then land the operator in pane 1.
  //
  // THE SECOND CALL IS NOT REDUNDANT, and the comment that used to sit here
  // claimed it was: "pane 1 is the initial surface and holds focus by
  // construction, so there is no second focus call to get wrong". Measured on
  // the first live run — focus was on pane 3. Every `new-split` moves focus to
  // the pane it creates, `--focus false` governs the WORKSPACE rather than the
  // split, and the operator therefore landed in the git watch, which is the one
  // pane that ignores input. The claim was reasoning about cmux; the run was
  // evidence about it.
  await client.runOk(selectWorkspaceArgv(wsId));
  firstPaneId = paneHoldingSurface(
    parseListPanes(await client.runOk(listPanesArgv(wsId))),
    created.surfaceId,
  );
  if (firstPaneId !== null) await client.runOk(focusPaneArgv(firstPaneId));
  await applyTopFraction(client, wsId, spec.topFraction);
  return { created: true, workspaceId: wsId };
}


/**
 * Give the top row {@link OPERATIONS_TOP_FRACTION} of the height.
 *
 * `new-split` has no size argument — it halves — so the shape is corrected here
 * against the geometry cmux reports rather than requested up front.
 *
 * EACH COLUMN IS RESIZED SEPARATELY, and that is a property of the layout
 * rather than caution: a 2x2 built by splitting each column downward has two
 * independent horizontal dividers, and moving one leaves the other where it
 * was. Measured — resizing a single top pane moved only its own column and left
 * the console visibly uneven.
 *
 * Best-effort on purpose. A console whose panes are all correct but evenly
 * split is fully usable; refusing to return one because a cosmetic resize
 * failed would trade the whole feature for a nicety.
 */
async function applyTopFraction(
  client: CmuxClient,
  wsId: string,
  fraction: number | null,
): Promise<void> {
  // `null` is a console of EQUAL panes saying it wants the halves `new-split`
  // already produced. Returning here rather than computing a delta of zero
  // keeps "no correction wanted" distinguishable from "correction computed to
  // nothing", which is the difference between a stated layout and a lucky one.
  if (fraction === null) return;
  try {
    const geo: ReturnType<typeof parsePaneGeometry> = parsePaneGeometry(await client.runOk(listPanesArgv(wsId)));
    if (geo.panes.length < 2) return;
    const topY = Math.min(...geo.panes.map((p) => p.y));
    const target = geo.containerHeight * fraction;
    for (const pane of geo.panes) {
      if (pane.y !== topY) continue;
      const delta = target - pane.height;
      // Sub-pixel deltas are what an already-correct layout produces; issuing
      // them would be a no-op command per pane on every adoption.
      if (Math.abs(delta) < 1) continue;
      await client.runOk(
        resizePaneArgv(pane.paneId, delta > 0 ? "D" : "U", Math.abs(delta)),
      );
    }
  } catch {
    // See the docblock: layout is cosmetic, the console is not.
  }
}

/**
 * The entry point: build it, or find it already built and leave it alone.
 *
 * ## `recreate` exists because idempotence has a failure mode
 *
 * Adoption is the requested behaviour and stays the default: a second
 * `operations` must not stack a duplicate console on top of the one the
 * operator is working in. But adoption leaves the PANES exactly as they are,
 * and a pane's contents are not part of what `findOperations` matches on — it
 * matches a workspace TITLE. So a console whose panes died, or whose commands
 * were built by an older version of this script, is adopted forever and there
 * is no flag that refreshes it.
 *
 * MEASURED 2026-08-30, and it is the shape a reader should expect rather than
 * a hypothetical. An `operations` workspace launched before `envPreamble` and
 * before `~/.env` carried the ticket variables showed: a ticketing pane holding
 * a dead `up` that had refused on unset secrets, a `fleet-status` pane still
 * watching a run from six days earlier, and a git watch that looked healthy
 * because it is the one pane that re-polls. Every later `operations` selected
 * that workspace and reported "already in place — changed nothing", which was
 * true and useless.
 *
 * The escape hatch replaces the WORKSPACE rather than respawning each pane,
 * because the pane SET is part of the plan: a console built by an older version
 * may have a different number of panes in different places, and respawning the
 * ones that happen to exist would leave a half-migrated layout that matches
 * neither version.
 *
 * ## BUILD FIRST, CLOSE SECOND — and the first version had this backwards
 *
 * Closing first is the obvious order and it is wrong. MEASURED 2026-08-30, on
 * the operator's own console: `operations` was the ONLY workspace, closing it
 * left the cmux app with no window, and the very next call failed with
 * `unavailable: TabManager not available`. So did every call after it — even
 * `workspace list` — because a windowless cmux has no tab manager to answer
 * with. The flag whose entire job is to repair a stale console had destroyed a
 * working one and left nothing able to rebuild it; recovery took `cmux <path>`
 * from a shell, which is exactly the manual step this script exists to spare.
 *
 * The argument FOR closing first was that `findOperations` matches an exact
 * title, so building first leaves two workspaces briefly wearing one name. That
 * is true and it is the lesser risk by a wide margin: the window is a few
 * hundred milliseconds inside one function, nothing re-queries by title during
 * it, and the old id is already in hand — so the close targets a captured
 * UUID and cannot pick the wrong one. Weigh a transient ambiguity nothing
 * observes against a destroyed console that cannot be rebuilt, and the order
 * is not a close call.
 *
 * If the create THROWS, the old console is still standing. That is the right
 * failure: a stale console beats no console, which is the whole lesson above.
 */
export async function ensureWorkspace(
  client: CmuxClient,
  spec: WorkspaceSpec,
  opts: OperationsPlanOptions,
  recreate = false,
): Promise<EnsureResult> {
  const existing = await findWorkspace(client, spec.name);
  if (existing !== null && !recreate) {
    await client.runOk(selectWorkspaceArgv(existing));
    return { created: false, workspaceId: existing };
  }
  const built = await createWorkspace(client, spec, opts);
  // By CAPTURED ID, never by a re-query: the only moment two workspaces share
  // this title is between these two lines, and resolving the name here is the
  // one thing that could close the console just built.
  if (existing !== null) await client.runOk(workspaceCloseArgv(existing));
  return built;
}

/**
 * {@link ensureWorkspace} for the operations console.
 *
 * Kept as a named entry point rather than folded into its caller: `operations`
 * is the console this repository is driven from, and a bare `ensureWorkspace`
 * call site would make the default one argument among three rather than the
 * thing the script is for.
 */
export async function ensureOperations(
  client: CmuxClient,
  opts: OperationsPlanOptions,
  recreate = false,
): Promise<EnsureResult> {
  return ensureWorkspace(client, OPERATIONS_SPEC, opts, recreate);
}

/** {@link ensureWorkspace} for the four-agent development console. */
export async function ensureDevelopment(
  client: CmuxClient,
  opts: OperationsPlanOptions,
  recreate = false,
): Promise<EnsureResult> {
  return ensureWorkspace(client, DEVELOPMENT_SPEC, opts, recreate);
}
