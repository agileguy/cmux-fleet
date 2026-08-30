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
  newSplitArgv,
  pingArgv,
  renameTabArgv,
  respawnPaneArgv,
  workspaceCreateArgv,
  workspaceListArgv,
  type SplitDirection,
} from "./client.ts";
import {
  findWorkspaceByTitle,
  parseNewSplit,
  parseWorkspaceCreate,
  parseWorkspaceList,
} from "./parse.ts";
import { OPERATIONS_WORKSPACE, operationsPanes, type OperationsPlanOptions } from "./operations-plan.ts";

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

/** The existing `operations` workspace, or null. */
export async function findOperations(client: CmuxClient): Promise<string | null> {
  const list = parseWorkspaceList(await client.runOk(workspaceListArgv()));
  return findWorkspaceByTitle(list, OPERATIONS_WORKSPACE)?.id ?? null;
}

/**
 * Create the workspace and its three panes, in order.
 *
 * The first pane CONSUMES the surface `workspace create` opens with — leaving
 * it as a stray idle shell and splitting three more off it would give four
 * panes, one of them empty. Splits then alternate right/down off the most
 * recent surface, which is the sequence `src/backends/cmux/index.ts` already
 * uses to lay out a fleet.
 */
export async function createOperations(
  client: CmuxClient,
  opts: OperationsPlanOptions,
): Promise<EnsureResult> {
  const panes = operationsPanes(opts);

  // `--cwd` is the INVOCATION directory: panes 2 and 3 are about where the
  // operator is working, not about where this repository happens to live.
  const created = parseWorkspaceCreate(
    await client.runOk(workspaceCreateArgv(OPERATIONS_WORKSPACE, opts.watchDir)),
  );
  const wsId = created.workspaceId;

  let anchor = created.surfaceId;

  for (let i = 0; i < panes.length; i += 1) {
    const pane = panes[i]!;
    let surfaceId: string;

    if (i === 0) {
      surfaceId = created.surfaceId;
    } else {
      const dir: SplitDirection = i % 2 === 1 ? "right" : "down";
      surfaceId = parseNewSplit(await client.runOk(newSplitArgv(wsId, anchor, dir))).surfaceId;
    }

    // Rename BEFORE respawning. `respawn-pane` restarts the surface's shell,
    // and a title set on a surface that is about to be replaced is a title
    // that may not survive; this order is the one the fleet backend uses.
    await client.runOk(renameTabArgv(wsId, surfaceId, pane.title));
    await client.runOk(respawnPaneArgv(wsId, surfaceId, pane.command));

    anchor = surfaceId;
  }

  // Bring the workspace forward. Pane 1 — the ticketing console, the only
  // pane anyone types into — is the workspace's initial surface and holds
  // focus by construction, so there is no second focus call to get wrong.
  await client.runOk(selectWorkspaceArgv(wsId));
  return { created: true, workspaceId: wsId };
}

/**
 * The entry point: build it, or find it already built and leave it alone.
 */
export async function ensureOperations(
  client: CmuxClient,
  opts: OperationsPlanOptions,
): Promise<EnsureResult> {
  const existing = await findOperations(client);
  if (existing !== null) {
    await client.runOk(selectWorkspaceArgv(existing));
    return { created: false, workspaceId: existing };
  }
  return createOperations(client, opts);
}
