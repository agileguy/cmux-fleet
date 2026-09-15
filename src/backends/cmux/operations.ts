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
  listPaneSurfacesArgv,
  listPanesArgv,
  newSplitArgv,
  pingArgv,
  renameTabArgv,
  resizePaneArgv,
  respawnPaneArgv,
  workspaceCloseArgv,
  workspaceCreateArgv,
  workspaceGroupAddArgv,
  workspaceGroupListArgv,
  workspaceListArgv,
  workspaceSetColorArgv,
} from "./client.ts";
import {
  findWorkspaceByTitle,
  findWorkspaceGroupByName,
  parseListPanes,
  parseNewSplit,
  parsePaneGeometry,
  parsePaneSurfaces,
  parseWorkspaceCreate,
  parseWorkspaceGroupList,
  parseWorkspaceList,
  type PaneListed,
} from "./parse.ts";
import {
  DEVELOPMENT_TOP_FRACTION,
  DEVELOPMENT_WORKSPACE,
  OPERATIONS_TOP_FRACTION,
  OPERATIONS_WORKSPACE,
  REVIEW_REVIEWER_WIDTH_FRACTION,
  REVIEW_TOP_FRACTION,
  REVIEW_WORKSPACE,
  TRIAGE_OBSERVER_WIDTH_FRACTION,
  TRIAGE_TOP_FRACTION,
  TRIAGE_WORKSPACE,
  developmentPanes,
  operationsPanes,
  reviewPanes,
  triagePanes,
  type OperationsPane,
  type OperationsPlanOptions,
} from "./operations-plan.ts";

/**
 * Everything that differs between one standing console and another.
 *
 * The BUILDER below is identical for all four — create a workspace, consume its
 * initial surface, split the rest off in the directions the plan names, rename,
 * respawn, focus pane 1. Only three things vary, and they are exactly these
 * three. Adding a console is then a value in this file rather than a second
 * copy of `createWorkspace`, which is the copy that would drift: the
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
  /**
   * Fraction of the WIDTH each pane gets, in EVERY ROW OF TWO OR MORE PANES —
   * or `null` to leave the halves `new-split` produces alone.
   *
   * A second field rather than a reuse of {@link topFraction}, because the two
   * say different things and only one of them is a ratio between rows: a top
   * fraction divides ONE border, and this divides the N−1 borders inside EACH
   * qualifying row. Folding them together would make `0.5` mean "half the
   * height above" in one console and "two equal columns below" in another.
   *
   * **NOT `null` on every console but `triage`** — that was true once and is a
   * stale claim now. `review` carries {@link REVIEW_REVIEWER_WIDTH_FRACTION}
   * (`1/3`) too, since it took `triage`'s collator-over-a-row shape on
   * 2026-09-13. It stays `null` on `operations` and `development`, and for
   * different reasons: `operations`'s bottom row is the single merged monitor,
   * with no internal border to divide, and `development` is a 2x2 where two
   * columns each split once are already equal, so a correction there would be
   * a no-op dressed as a decision. {@link DEVELOPMENT_TOP_FRACTION} records why
   * a value that rounds to nothing must not stand in for a stated one, and the
   * same rule governs here.
   */
  readonly bottomWidthFraction: number | null;
}

/**
 * A spec's panes, WITH THE WORKSPACE TITLE FOLDED IN.
 *
 * The one place `spec.panes` is reached, so the title the panes advertise to
 * `up --workspace-name` is by construction the title `workspace create --name`
 * used and `findWorkspace` matches on (`spec.name`, both). A caller passing its
 * own `workspaceName` would be a second spelling of one fact, and the two would
 * be identical the day they were written and only diverge afterwards — the same
 * drift `agentSquarePanes` was extracted to prevent.
 *
 * It is a function rather than a spread at each call site because there are two
 * call sites — `restartConsolePane` and `createWorkspace` — and one of them
 * forgetting the fold is a console whose restarted pane silently stops naming
 * its workspace while every other pane still does.
 */
function planPanes(spec: WorkspaceSpec, opts: OperationsPlanOptions): OperationsPane[] {
  return spec.panes({ ...opts, workspaceName: spec.name });
}

/** The day-to-day console: one agent pair on top, status and git below. */
export const OPERATIONS_SPEC: WorkspaceSpec = {
  name: OPERATIONS_WORKSPACE,
  panes: operationsPanes,
  topFraction: OPERATIONS_TOP_FRACTION,
  // ONE pane in the bottom row — the merged monitor — so there is no border
  // inside it to divide. See {@link WorkspaceSpec.bottomWidthFraction}.
  bottomWidthFraction: null,
};

/** The four-agent console: two engineers on top, two testers below. */
export const DEVELOPMENT_SPEC: WorkspaceSpec = {
  name: DEVELOPMENT_WORKSPACE,
  panes: developmentPanes,
  topFraction: DEVELOPMENT_TOP_FRACTION,
  // A 2x2: one split gives two equal columns already.
  bottomWidthFraction: null,
};

/**
 * The multi-model review console: ONE collator across the top, three reviewers
 * in a row beneath it, each reviewer on a different vendor's model.
 *
 * The THIRD value in this file rather than a third builder, which is the point
 * {@link WorkspaceSpec} was written to make: adding a console is a value here,
 * so the BUILD-FIRST-CLOSE-SECOND order in `ensureWorkspace` — a measured
 * lesson that cost a destroyed console once — is stated in exactly one place
 * and cannot be got backwards a third time.
 *
 * **IT WAS A 2x2 WITH THE COLLATOR TOP-LEFT UNTIL 2026-09-13, and both
 * fractions below were `null` because of it.** The operator asked for this
 * console to match `triage`, and the entire cost of that here was two values —
 * no branch, no fifth builder, no new argument. That is the bet
 * {@link WorkspaceSpec} was written to win, collected a second time.
 */
export const REVIEW_SPEC: WorkspaceSpec = {
  name: REVIEW_WORKSPACE,
  panes: reviewPanes,
  topFraction: REVIEW_TOP_FRACTION,
  // A row of THREE reviewers, which halving gives as 50/25/25 rather than
  // thirds. See {@link REVIEW_REVIEWER_WIDTH_FRACTION}.
  bottomWidthFraction: REVIEW_REVIEWER_WIDTH_FRACTION,
};

/**
 * The scheduled triage console: ONE collator across the top, THREE observers in
 * a row beneath it — and, in the tracked `fleet.example.yaml`, no keyboard in
 * any of them. (A reconciler and ONE observer in a single row until 2026-09-12;
 * two such pairs in a 2x2 for one day after that.)
 *
 * The FOURTH value in this file and still not a fourth builder, which is the
 * whole of what {@link WorkspaceSpec} was written to buy and the whole of what
 * SRD-TRIAGE-CONSOLE D5 bet on. Four fields, no branch, no new argument: the
 * BUILD-FIRST-CLOSE-SECOND order in {@link ensureWorkspace} — a measured lesson
 * that cost a destroyed console once — is stated in exactly one place and cannot
 * be got backwards a fourth time.
 *
 * **BOTH FRACTIONS ARE NUMBERS HERE.** This was the ONLY spec carrying a second
 * one until 2026-09-13, when `review` was asked to take the same shape and
 * became the other — so the sentence that used to sit here ("the only spec
 * where either second one is") lasted exactly one day, which is worth recording
 * as a caution about uniqueness claims rather than quietly deleting. That is
 * what the shape bought and what it costs: a console of
 * one full-width row over a row of three is the first layout in this repository
 * that `new-split` cannot produce correctly on its own. Halving gives 50/50
 * vertically and 50/25/25 horizontally, and neither is what this console means —
 * the three observers are handed EVEN slices of the environment, so a row that
 * renders one at twice the width of its siblings describes work that is not
 * being done. {@link TRIAGE_TOP_FRACTION} and
 * {@link TRIAGE_OBSERVER_WIDTH_FRACTION} carry the arguments.
 *
 * **The previous version of this docblock asserted the opposite and was right
 * when written**, which is why the reversal is recorded rather than overwritten:
 * it said `DEFAULT_TRIAGE_WORKERS` *"names TWO workers … THERE IS NO SECOND
 * ROW"*, and on a two-seat console that was exactly true. It went stale in place
 * when the roster grew, with nothing to redden — the same failure mode
 * {@link TRIAGE_TOP_FRACTION} now warns about at greater length.
 */
export const TRIAGE_SPEC: WorkspaceSpec = {
  name: TRIAGE_WORKSPACE,
  panes: triagePanes,
  topFraction: TRIAGE_TOP_FRACTION,
  bottomWidthFraction: TRIAGE_OBSERVER_WIDTH_FRACTION,
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

/** A console pane, resolved to the title `createWorkspace` gave it. */
export interface TitledPane {
  readonly paneId: string;
  readonly surfaceId: string;
  /** `null` when the pane carries no title — see {@link parsePaneSurfaces}. */
  readonly title: string | null;
}

/**
 * Every pane in a workspace, each carrying its title.
 *
 * One `list-panes` plus one `list-pane-surfaces` per pane. The second call is
 * per-pane because the verb answers for ONE pane and defaults to the focused
 * one, so a single call would describe whichever pane the operator last
 * clicked and would look like an answer about all of them.
 */
export async function titledPanes(
  client: CmuxClient,
  workspaceId: string,
): Promise<TitledPane[]> {
  const panes = parseListPanes(await client.runOk(listPanesArgv(workspaceId)));
  const out: TitledPane[] = [];
  for (const p of panes) {
    const surfaces = parsePaneSurfaces(
      await client.runOk(listPaneSurfacesArgv(workspaceId, p.paneId)),
    );
    /*
     * The SELECTED surface is the pane, and its absence is not a reason to
     * skip the pane. A pane cmux reports with no selected surface still holds
     * one, and dropping it here would turn "this console is in a state I did
     * not expect" into "that worker has no pane", which reads as a typo and
     * sends the operator to fix the wrong thing.
     */
    const chosen = surfaces.find((s) => s.selected) ?? surfaces[0];
    if (chosen === undefined) continue;
    out.push({ paneId: p.paneId, surfaceId: chosen.surfaceId, title: chosen.title });
  }
  return out;
}

/**
 * Which surface holds `title`, or `null`.
 *
 * Title, never index — see {@link listPaneSurfacesArgv} for the measurement
 * that makes the distinction load-bearing rather than stylistic.
 */
export function surfaceForTitle(panes: readonly TitledPane[], title: string): string | null {
  return panes.find((p) => p.title === title)?.surfaceId ?? null;
}

/**
 * WHY A WORKSPACE MAY NOT BE ADOPTED — SRD-REVIEW-CONSOLE §6.10, and `null` when
 * it may.
 *
 * ## The measured hazard, not a hypothetical one
 *
 * §0.5 correction 5: **a `review` workspace already existed on this machine**
 * before this console did, and `findWorkspaceByTitle` matches `custom_title`
 * EXACTLY. So `ensureWorkspace` adopts it, `--recreate` closes it, and
 * `--restart <id>` respawns one of its panes with a `pifleet up` command. Every
 * one of those is destruction of a window somebody was working in, arrived at by
 * a name collision, and §6.10 states the consequence in as many words: *"Silently
 * adopting a person's workspace and respawning its panes is data loss."*
 *
 * ## Verify rather than refuse outright, which §6.10 offers as the alternative
 *
 * The bare refusal — "a `review` workspace exists, pass `--recreate`" — would
 * also refuse the LEGITIMATE re-open, and `scripts/review`'s own docblock says
 * re-running it *"is the expected way to get back to the console"*. Verifying is
 * the arm that keeps that: a workspace whose panes are this console's panes is
 * this console, and one whose panes are anything else is somebody's window.
 *
 * ## Titles as a MULTISET, and why not in order
 *
 * `createWorkspace` titles each pane with its worker id (`operations-plan.ts`,
 * *"The id is also what `dispatch --worker` takes, so the title is the
 * argument"*), so the planned titles are exactly what a console of ours holds. A
 * multiset comparison catches a missing pane, an extra pane, an unfamiliar pane
 * and a duplicated one.
 *
 * ORDER IS DELIBERATELY NOT CHECKED. `list-panes` does not promise creation
 * order, so an order comparison would refuse a healthy console on a property
 * cmux never guaranteed — a FALSE refusal, which here means telling an operator
 * to `--recreate` a console that was fine, i.e. causing the exact destruction
 * this guard exists to prevent. The layout is re-asserted by the plan on every
 * rebuild and is checked structurally by the plan's own suite.
 */
export function adoptionRefusal(
  workspaceName: string,
  present: readonly (string | null)[],
  planned: readonly string[],
): string | null {
  const key = (xs: readonly (string | null)[]): string =>
    [...xs].map((t) => t ?? "\u0000untitled").sort().join("\u0001");
  if (key(present) === key(planned)) return null;
  return (
    `${workspaceName}: a workspace already titled '${workspaceName}' is open and its panes are ` +
    `not this console's. It holds ${
      present.length === 0 ? "no panes" : present.map((t) => t ?? "(untitled)").join(", ")
    }; this console plans ${planned.join(", ")}. It is NOT adopted: adopting it would respawn ` +
    `those panes with pifleet commands and lose whatever is in them. Rename or close that ` +
    `workspace, or pass --recreate to replace it deliberately.`
  );
}

/** What {@link restartConsolePane} did, for the caller to report. */
export interface RestartResult {
  readonly workspaceId: string;
  readonly surfaceId: string;
  /** The titles the console actually holds, for a refusal message. */
  readonly present: readonly (string | null)[];
}

/**
 * The pane this console plans under `title`, or a refusal naming the ones it
 * does plan.
 *
 * Pure — no cmux call, no run lookup, no side effect — and that is the whole
 * point of it being separate from {@link restartConsolePane}. A `--restart`
 * has to stop the run the worker holds BEFORE the pane is respawned (see that
 * function's contract), so every script's restart path is an irreversible
 * teardown followed by a rebuild. Resolving the title inside the rebuild puts
 * the only check AFTER the only destruction.
 *
 * Measured 2026-09-06: `./scripts/operations --restart obs-1` stopped
 * `obs-1`'s run and then refused, because the teardown keys on WORKER ID
 * (`runsHoldingAny`) while the respawn keys on PANE TITLE, and this console's
 * agent panes are titled `observer` and `ticketing`. Both operations workers
 * were left down with nothing respawned. The general shape is worse than the
 * instance: any live worker id a console does not plan is reachable this way,
 * including a development or review console asked for another console's
 * worker, and on `review` the relay is stopped first as well.
 *
 * So the scripts call this FIRST, before they stop anything, and
 * `restartConsolePane` calls it too — one spelling of "is this a pane here",
 * because two would be identical the day they were written.
 */
export function plannedPane(
  spec: WorkspaceSpec,
  opts: OperationsPlanOptions,
  title: string,
): OperationsPane {
  const plan = planPanes(spec, opts);
  /*
   * TITLE FIRST, THEN WORKER ID, and accepting both is half of ISC-1106's fix.
   *
   * On the agent-square consoles the two are the same string, so this is one
   * lookup written twice. On `operations` they differ — panes are titled by
   * ROLE (`observer`) and run `obs-1` — and naming the worker used to be
   * REFUSED while naming the title silently orphaned the container. An operator
   * who reaches for the id every other console takes should not be the one who
   * finds that out.
   *
   * Title wins a tie because it is what this function's own error message
   * offers, and no console has a pane whose title is another pane's worker.
   */
  const planned =
    plan.find((p) => p.title === title) ?? plan.find((p) => p.worker === title);
  if (planned === undefined) {
    throw new Error(
      `${spec.name}: '${title}' is not a pane this console plans — it holds ` +
        `${plan.map((p) => (p.worker === undefined || p.worker === p.title ? p.title : `${p.title} (${p.worker})`)).join(", ")}`,
    );
  }
  return planned;
}

/**
 * Restart ONE console pane, leaving every other pane alone.
 *
 * This is the whole of "restart a single worker" in a console, and it is a
 * pane operation rather than a container one for a reason worth stating: a
 * worker's container is a CHILD of its supervisor (`supervisor/index.ts` —
 * on the `rpc` path the supervisor's `child` IS a foreground `docker run`),
 * and each agent pane runs its own `up --attach-here`, so the pane owns the
 * run, the run owns the supervisor, and the supervisor owns the container.
 * Replacing the container under a live supervisor would leave the supervisor
 * holding a handle to a process that no longer exists. Respawning the pane
 * re-enters at the top of that chain and lets the existing, tested `up` path
 * rebuild all of it.
 *
 * The caller is responsible for stopping any run the worker still holds
 * BEFORE calling this. Respawning a pane kills the pane's process tree, which
 * is not the same as quiescing a run: the supervisor would be signalled by the
 * shell rather than told to shut down, and the container it launched detached
 * would outlive it as an orphan.
 */
export async function restartConsolePane(
  client: CmuxClient,
  spec: WorkspaceSpec,
  opts: OperationsPlanOptions,
  title: string,
): Promise<RestartResult> {
  const workspaceId = await findWorkspace(client, spec.name);
  if (workspaceId === null) {
    throw new Error(
      `${spec.name}: no ${spec.name} workspace is open, so there is no pane to restart — ` +
        `open the console first`,
    );
  }
  const planned = plannedPane(spec, opts, title);
  const panes = await titledPanes(client, workspaceId);
  const surfaceId = surfaceForTitle(panes, title);
  if (surfaceId === null) {
    /*
     * The open console does not hold the pane the plan names. That is a real
     * divergence — a `--workers` set that differs from the one the console was
     * built with, or a pane closed by hand — and it is reported with what IS
     * there rather than as "not found", because the two fixes differ.
     */
    throw new Error(
      `${spec.name}: no pane titled '${title}' in the open console, which holds ` +
        `${panes.map((p) => p.title ?? "(untitled)").join(", ")} — ` +
        `rebuild it with --recreate if the worker set changed`,
    );
  }
  await client.runOk(respawnPaneArgv(workspaceId, surfaceId, planned.command));
  return { workspaceId, surfaceId, present: panes.map((p) => p.title) };
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
 * The sidebar group every console belongs in.
 *
 * A NAME rather than an id, resolved on each rebuild — see
 * {@link findWorkspaceGroupByName} for why neither a `workspace_group:N` ref
 * nor a UUID can be written down here.
 */
export const FLEET_WORKSPACE_GROUP = "pi-fleet";

/**
 * Put a freshly built console back where the old one was: in its group, wearing
 * its colour.
 *
 * ## Both halves are BEST-EFFORT, and that is the design
 *
 * Every call here goes through `client.run` rather than `runOk`, so a non-zero
 * exit is read and dropped instead of thrown. A console sitting outside its
 * sidebar group, or wearing no colour, is a cosmetic fault; a console that
 * REFUSED TO REBUILD because a group had been renamed is an outage on the
 * thing `--recreate` exists to repair. The rebuild is what is being protected,
 * and it has already succeeded by the time this runs.
 *
 * ## The colour is passed in, not read here
 *
 * It has to be captured from the OLD workspace before that workspace is closed,
 * which happens in {@link ensureWorkspace} — after the close there is nothing
 * left to read it from. `null` means the operator never set one, and then
 * nothing is applied: a console that had no colour must not acquire one from a
 * rebuild.
 */
async function restoreWorkspacePresentation(
  client: CmuxClient,
  workspaceId: string,
  color: string | null,
): Promise<void> {
  /*
   * TWO separate guards, not one around both, so a group failure still leaves
   * the colour restored and vice versa. They are independent repairs and there
   * is no reason for one to cost the other.
   *
   * The `catch` is doing real work rather than being defensive noise:
   * `parseWorkspaceGroupList` THROWS on output it does not recognise — that is
   * `parse.ts`'s whole doctrine and it is correct for every other caller — and
   * a cmux too old to know `workspace group` answers with exactly that. Without
   * this, a presentation detail would take down a rebuild that had already
   * succeeded, which is the opposite of what this function promises. Caught
   * here rather than made lenient there, so the strictness keeps protecting the
   * callers that want it.
   */
  try {
    const listed = await client.run(workspaceGroupListArgv());
    if (listed.code === 0) {
      const group = findWorkspaceGroupByName(
        parseWorkspaceGroupList(listed.stdout),
        FLEET_WORKSPACE_GROUP,
      );
      if (group !== null) await client.run(workspaceGroupAddArgv(group.id, workspaceId));
    }
  } catch {
    // Rebuilt, ungrouped. The operator can see that; a failed rebuild is worse.
  }
  try {
    // `workspaceSetColorArgv` refuses anything but `#rrggbb`. The value came
    // from cmux's own `custom_color` so it should always be one — but "should"
    // is not a reason to let a rebuild die on a colour.
    if (color !== null) await client.run(workspaceSetColorArgv(workspaceId, color));
  } catch {
    // Rebuilt, uncoloured.
  }
}

/**
 * Create the workspace and the panes `spec` plans, in order.
 *
 * The first pane CONSUMES the surface `workspace create` opens with — leaving it
 * as a stray idle shell and splitting one off it per planned pane would give one
 * pane too many, the extra one empty. Each later pane is split off the PREVIOUS
 * one, in the direction that pane's plan names; the directions are a property of
 * the layout and live in `operations-plan.ts`, not here.
 */
export async function createWorkspace(
  client: CmuxClient,
  spec: WorkspaceSpec,
  opts: OperationsPlanOptions,
): Promise<EnsureResult> {
  const panes = planPanes(spec, opts);

  // `--cwd` is the INVOCATION directory: a console is about where the operator
  // is working, not about where this repository happens to live.
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
  if (firstPaneId !== null) await client.runOk(focusPaneArgv(wsId, firstPaneId));
  await applyTopFraction(client, wsId, spec.topFraction);
  // HEIGHT FIRST, THEN WIDTH, and the order is not arbitrary even though the
  // two corrections are independent in this layout: the height pass moves the
  // row divider, which changes every bottom pane's `y`. The width pass re-reads
  // geometry, so it sees the settled rows rather than the ones it was planned
  // against — running it first would leave it computing against a row that is
  // about to move underneath it.
  await applyBottomWidths(client, wsId, spec.bottomWidthFraction);
  return { created: true, workspaceId: wsId };
}


/**
 * Give the top row {@link OPERATIONS_TOP_FRACTION} of the height.
 *
 * `new-split` has no size argument — it halves — so the shape is corrected here
 * against the geometry cmux reports rather than requested up front.
 *
 * A RESIZE ADDRESSES A BORDER, NOT A PANE, and that is the fact this function
 * got wrong for as long as it existed.
 *
 * `resize-pane --pane <id> -U` asks cmux to move the border ABOVE that pane. A
 * pane in the top row has none, and cmux refuses:
 *
 *   Error: invalid_state: Pane has no adjacent border in direction up
 *
 * So a top row that is too TALL cannot be corrected by shrinking a top pane;
 * the only border between the rows is the one below it, and the pane that can
 * move it upward is the one UNDERNEATH. The two directions therefore address
 * different rows:
 *
 *   divider DOWN  (grow the top row)    -> `-D` on a TOP pane
 *   divider UP    (shrink the top row)  -> `-U` on a BOTTOM pane
 *
 * Both always name a border that exists. Choosing the row by the SIGN of the
 * correction is what makes that true, and it is why this is not simply a loop
 * over the top row with a signed direction — which is what stood here, and
 * which threw `invalid_state` into the `catch` below on every console whose
 * top row needed to shrink. The layout then kept whatever `new-split` had
 * produced and nothing said so.
 *
 * THE GEOMETRY IS RE-READ BEFORE EVERY PANE, for the second half of the same
 * problem. The console this function actually builds is two agent panes over
 * ONE full-width monitor, so both top panes share a SINGLE divider. Computing
 * every delta from one snapshot moves that divider once per pane in the row,
 * each move starting where the last one left it.
 *
 * MEASURED 2026-09-03 against a 1052px container asked for a 65% top row: both
 * top panes were 629.6px, each was told to grow by the same 54.2px, and the row
 * ended at 737.6px — 70.1%, which is the target plus one extra application.
 * Re-reading drops the second pane's delta under the sub-pixel skip in that
 * layout, while a row with independent dividers per column still sees a real
 * delta for each and is corrected exactly as before. One rule covers both
 * shapes because it asks what the layout currently is instead of assuming
 * which one it is.
 *
 * Best-effort on purpose. A console whose panes are all correct but evenly
 * split is fully usable; refusing to return one because a cosmetic resize
 * failed would trade the whole feature for a nicety. That restraint is also
 * what hid both defects above for as long as it did, so the `catch` now says
 * what it swallowed.
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
  /**
   * A geometry read that cannot be parsed is SILENT, and a resize that is
   * REFUSED is not. The two failures say different things: the first means
   * this backend did not report a `container_frame` — every test double, and
   * any cmux whose `list-panes` shape moved — so there is nothing to correct
   * and nothing an operator could do. The second means the correction was
   * computed, attempted, and rejected, which is the case that went unreported
   * through every rebuild until it was measured.
   */
  let first: ReturnType<typeof parsePaneGeometry>;
  try {
    first = parsePaneGeometry(await client.runOk(listPanesArgv(wsId)));
  } catch {
    return;
  }
  try {
    if (first.panes.length < 2) return;
    const topY = Math.min(...first.panes.map((p) => p.y));
    const topTarget = first.containerHeight * fraction;
    const topHeight = Math.max(
      ...first.panes.filter((p) => p.y === topY).map((p) => p.height),
    );
    // Already right, and neither row needs a command. Checked before the row is
    // chosen because the sign of a sub-pixel delta is noise, and acting on it
    // would pick a row to issue a no-op against.
    if (Math.abs(topTarget - topHeight) < 1) return;
    const growTop = topTarget > topHeight;
    // The row that OWNS the border for this direction, and the direction that
    // names it from there. See the docblock: the other row has no such border
    // and the call is refused.
    const movingIds = first.panes
      .filter((p) => (growTop ? p.y === topY : p.y !== topY))
      .map((p) => p.paneId);
    const dir = growTop ? "D" : "U";
    for (const paneId of movingIds) {
      const geo = parsePaneGeometry(await client.runOk(listPanesArgv(wsId)));
      const pane = geo.panes.find((p) => p.paneId === paneId);
      if (pane === undefined) continue;
      // Expressed against the row being moved: the top row's target is the
      // fraction, the bottom row's is its complement.
      const target = geo.containerHeight * (growTop ? fraction : 1 - fraction);
      const delta = target - pane.height;
      // Sub-pixel deltas are what an already-correct layout produces; issuing
      // them would be a no-op command per pane on every adoption. With a shared
      // divider this is also the arm that stops the second pane re-applying a
      // correction the first one already made.
      if (Math.abs(delta) < 1) continue;
      // Only ever the direction chosen above. A delta whose sign disagrees with
      // it means the divider has already passed the target — the next pane's
      // re-read will see that as sub-pixel or as an overshoot, and either way
      // reversing here would fight the border from the row that cannot reach
      // it.
      if (delta < 0) continue;
      await client.runOk(resizePaneArgv(paneId, dir, delta));
    }
  } catch (err) {
    // See the docblock: layout is cosmetic, the console is not. But a silent
    // catch is how `invalid_state` went unreported through every rebuild, so
    // the operator gets a line and still gets a console.
    process.stderr.write(
      `operations: pane layout left as split ` +
        `(${err instanceof Error ? err.message : String(err)})\n`,
    );
  }
}

/**
 * Give every pane, in every row of two or more panes, an equal share of the
 * width.
 *
 * The horizontal twin of {@link applyTopFraction}, and it exists for the same
 * reason one rung down: `new-split` has no size argument, so a row of three
 * arrives as 50/25/25 — each `right` split halving only what the pane before it
 * held — and thirds are not reachable by halving at any depth.
 *
 * ## MORE THAN ONE ROW — GENERALIZED 2026-09-14, SRD-TRIAGE-MIXED-OBSERVERS §4.4/D5
 *
 * This corrected only the row sharing the LARGEST `y` until the triage
 * console grew a second full-width observer row (SRD-TRIAGE-MIXED-OBSERVERS
 * §4.2): a collator over TWO rows of three, not one. With two rows only the
 * lower one was ever settled, because "the bottom row" and "the largest `y`"
 * were the same fact for every console this pass had ever run against — a
 * premise that quietly stopped holding the moment a second row existed, with
 * nothing to redden.
 *
 * The fix widens the ROW SELECTION rather than the per-row arithmetic below,
 * which does not change at all. Group the first read's panes by distinct `y`
 * (exact equality, the same comparison the single-row version already used),
 * ASCENDING — top row first — and run the loop below once per group holding
 * two or more panes; a row of one (the operations console's merged monitor,
 * or a collator's own row here) has no internal border and is skipped.
 *
 * This is safe rather than merely convenient because EACH FULL-WIDTH ROW IS
 * ITS OWN SPLIT SUBTREE: {@link triagePanes}' seven-pane table opens the two
 * observer rows with two SEPARATE `down` splits, so a border moved inside one
 * row's subtree is invisible to the other row's panes — settling row one
 * first and row two second, or the other order, reaches the same end state
 * either way. Backward compatible by construction: `review` has exactly one
 * qualifying row, and reaches it exactly as before (`TRIAGE_OBSERVER_WIDTH_FRACTION`
 * and `REVIEW_REVIEWER_WIDTH_FRACTION` both stay `1/3`, since every row still
 * holds three panes).
 *
 * ## A ROW OF THREE IS A NESTED PAIR, NOT A FLAT SPLIT — MEASURED, NOT DERIVED
 *
 * This is the fact the whole function turns on, it is not visible anywhere in
 * `list-panes`, and the first version of this pass was written without it and
 * was wrong. A chain of `right` splits does not build one row of N cells; it
 * builds a right-nested tree, `[obs-t1 | [obs-t2 | obs-t3]]`, because each split
 * divides only the pane it was anchored on. That is also why the row arrives at
 * 50/25/25 rather than at thirds.
 *
 * The consequence is that a resize does NOT move width between two neighbours.
 * It moves the addressed border, and the space is redistributed PROPORTIONALLY
 * across the whole subtree on the far side. Measured on the live console
 * 2026-09-13, `resize-pane --pane obs-t2 -L --amount 30` against 265/176/352:
 *
 *   obs-t1  265 -> 235   lost all 30, as expected
 *   obs-t2  176 -> 186   gained only 10
 *   obs-t3  352 -> 372   gained 20
 *
 * The 30px came out of one pane and was shared 1:2 between the two on the right
 * — exactly their existing ratio. `--amount` is pixels, as
 * {@link resizePaneArgv} says; what is not pixels is the ASSUMPTION that one
 * border move touches one neighbour.
 *
 * **The pass this replaces walked RIGHT TO LEFT and grew each pane in turn**,
 * on the reasoning that a `right`-split chain leaves the leftmost pane widest,
 * so every pane needing to shrink is the one the next step steals from. That
 * argument is sound for a flat row and lands on 265/265/265. Against the real
 * tree it lands on 265.67/176.83/352.83, because the second step's "left
 * neighbour" is the outer border and its take is split 1:2 down the subtree.
 * The console rendered 265/176/352. **The discarded model predicted the wrong
 * numbers and the tree model predicts the observed ones to the pixel**, which is
 * the only reason this docblock states the tree as fact rather than as a theory.
 *
 * ## SO, PER ROW: LEFT TO RIGHT, ONE BORDER AT A TIME, SIGN CHOOSES THE PANE
 *
 * Within a row, settle the leftmost border so pane 0 is exactly its share;
 * whatever that redistributes to the right is then settled by the next step,
 * and so on. The LAST pane in the row is never addressed — it holds the
 * remainder, which is correct once every border to its left is. Nothing needs
 * to predict the proportional redistribution, because each step re-reads
 * after it.
 *
 * Direction comes from the sign, which is {@link applyTopFraction}'s own rule
 * rather than a new one — and it is what the first version reached past when it
 * picked an ORDER instead. Both panes touch the divider between them, so one of
 * the two always has it adjacent in the direction it must travel:
 *
 *   widen pane i   -> divider RIGHT -> `-R` on pane i
 *   narrow pane i  -> divider LEFT  -> `-L` on pane i+1
 *
 * This also removes the old version's grow-only restriction and the four-pane
 * caveat that came with it: no step ever squeezes an intermediate pane, because
 * no step asks for more than one border's worth of movement.
 *
 * Best-effort for {@link applyTopFraction}'s reason, and with its remedy: a
 * console whose panes are all correct but unevenly split is fully usable, so a
 * cosmetic failure must not take the workspace down — but the `catch` says what
 * it swallowed, because a silent one is how two defects survived every rebuild.
 */
async function applyBottomWidths(
  client: CmuxClient,
  wsId: string,
  fraction: number | null,
): Promise<void> {
  // `null` is a console saying it wants the columns `new-split` produced —
  // every 2x2 in this file. Returning before any geometry is read keeps "no
  // correction wanted" distinguishable from "correction computed to nothing".
  if (fraction === null) return;
  let first: ReturnType<typeof parsePaneGeometry>;
  try {
    first = parsePaneGeometry(await client.runOk(listPanesArgv(wsId)));
  } catch {
    // The geometry read failed, which on every test double means no
    // `container_frame` at all. Nothing to correct and nothing an operator
    // could do about it. See {@link applyTopFraction}'s note on the two
    // distinct failures.
    return;
  }
  try {
    if (first.panes.length < 2) return;
    // Every row, ASCENDING by `y` — top to bottom — grouped from this ONE
    // read. Compared BETWEEN panes rather than against zero: `container_frame`
    // is a size with no origin and pane coordinates carry the window's own
    // offsets, so only the relative ordering means anything (`parse.ts`,
    // `parsePaneGeometry`). Each distinct `y` is its own split subtree (see
    // the docblock), so settling one row's borders never moves another row's,
    // and the order rows are visited in does not change the end state.
    const rowYs = [...new Set(first.panes.map((p) => p.y))].sort((a, b) => a - b);
    for (const y of rowYs) {
      const row = first.panes.filter((p) => p.y === y).sort((a, b) => a.x - b.x);
      // A row of one pane has no internal border to divide — the operations
      // console's merged monitor, and every collator's own row, are exactly
      // this shape. Nothing to do there, and issuing a resize would address a
      // border that is not there.
      if (row.length < 2) continue;
      // LEFT TO RIGHT WITHIN THE ROW, and never the LAST pane: each step
      // settles one border and leaves the rest of the row to the steps after
      // it. The final pane is not addressed at all — it holds the remainder,
      // which is its share once every border to its left is where it belongs.
      for (let i = 0; i < row.length - 1; i += 1) {
        const paneId = row[i]!.paneId;
        const nextId = row[i + 1]!.paneId;
        // Re-read before EVERY border — and for a stronger reason than
        // {@link applyTopFraction}'s. There, one move shifted the neighbour
        // the next delta was computed against. Here one move shifts SEVERAL
        // panes at once, proportionally, and no snapshot taken beforehand can
        // say by how much. Measuring after each step is what lets this pass
        // stay ignorant of the redistribution rule rather than having to
        // model it.
        const geo = parsePaneGeometry(await client.runOk(listPanesArgv(wsId)));
        const pane = geo.panes.find((p) => p.paneId === paneId);
        if (pane === undefined) continue;
        const delta = geo.containerWidth * fraction - pane.width;
        // Sub-pixel deltas are what an already-correct row produces; issuing
        // them would be a no-op command per border on every adoption.
        if (Math.abs(delta) < 1) continue;
        // The SIGN picks which pane to address, so the border is always
        // adjacent in the direction it has to travel — the same rule, and the
        // same reason, as choosing a ROW by the sign in
        // {@link applyTopFraction}.
        await (delta > 0
          ? client.runOk(resizePaneArgv(paneId, "R", delta))
          : client.runOk(resizePaneArgv(nextId, "L", -delta)));
      }
    }
  } catch (err) {
    process.stderr.write(
      `operations: observer row left as split ` +
        `(${err instanceof Error ? err.message : String(err)})\n`,
    );
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
  /**
   * §6.10's adoption guard, OPT-IN — `undefined` keeps this function's existing
   * behaviour byte for byte.
   *
   * Opt-in rather than universal because the hazard is not universal. §6.10
   * scopes the refusal to `scripts/review`, and it is scoped there because
   * `review` is the console whose name collided with a workspace that was
   * already open. `operations` and `development` have been adopting their own
   * workspaces for months against consoles this repository created, and turning
   * a guard on for them would convert every stale-but-mine console — the exact
   * state the `--recreate` docblock above describes and tolerates — into a
   * refusal. A guard that fires on the healthy case is one that gets deleted.
   *
   * The predicate is passed IN rather than derived from `spec`, so this function
   * stays a workspace operation and the console-shaped policy stays with the
   * console.
   */
  guard?: (panes: readonly TitledPane[]) => string | null,
): Promise<EnsureResult> {
  // The ROW, not just the id: `customColor` is only readable while the old
  // workspace still exists, and it stops existing three lines below.
  const previous = findWorkspaceByTitle(
    parseWorkspaceList(await client.runOk(workspaceListArgv())),
    spec.name,
  );
  const existing = previous?.id ?? null;
  if (existing !== null && !recreate) {
    /**
     * CHECKED BEFORE THE SELECT, not after. `selectWorkspaceArgv` raises
     * somebody else's window to the front and steals their focus, which is a
     * small harm and still one this refusal has no reason to cause.
     */
    if (guard !== undefined) {
      const refusal = guard(await titledPanes(client, existing));
      if (refusal !== null) throw new Error(refusal);
    }
    await client.runOk(selectWorkspaceArgv(existing));
    return { created: false, workspaceId: existing };
  }
  const built = await createWorkspace(client, spec, opts);
  // BEFORE the close, not after. The close is the step with a known failure
  // mode — a pinned workspace refuses it — and if it does fail, the rebuilt
  // console should already be in its group wearing its colour rather than
  // stranded outside both. Nothing here depends on the old workspace still
  // existing: its colour was read at the top of this function.
  await restoreWorkspacePresentation(client, built.workspaceId, previous?.customColor ?? null);
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

/**
 * {@link ensureWorkspace} for the four-agent multi-model review console, WITH
 * §6.10's adoption guard.
 *
 * The one console that carries it, and the reason is `Docs/SRD-REVIEW-CONSOLE.md`
 * §0.5 correction 5: a `review` workspace was already open on this machine
 * before this feature existed. See {@link adoptionRefusal}.
 *
 * `--recreate` is deliberately NOT guarded. It is the operator saying "replace
 * that workspace", which is the whole remedy the refusal names, and a flag whose
 * own error message tells you to pass it and then refuses when you do is not a
 * guard, it is a wall.
 */
export async function ensureReview(
  client: CmuxClient,
  opts: OperationsPlanOptions,
  recreate = false,
): Promise<EnsureResult> {
  const planned = planPanes(REVIEW_SPEC, opts).map((p) => p.title);
  return ensureWorkspace(client, REVIEW_SPEC, opts, recreate, (panes) =>
    adoptionRefusal(
      REVIEW_SPEC.name,
      panes.map((p) => p.title),
      planned,
    ),
  );
}

/**
 * {@link ensureWorkspace} for the scheduled triage console.
 *
 * Identical in shape to {@link ensureDevelopment} and deliberately NOT to
 * {@link ensureReview}, which is the one decision in this function and is worth
 * the paragraph it costs.
 *
 * ## NO ADOPTION GUARD, and that is a choice rather than an omission
 *
 * `ensureReview` carries §6.10's guard for a MEASURED reason, not a
 * precautionary one: a `review` workspace was already open on this machine
 * before the console existed, so the exact-title match had something real to
 * collide with. {@link adoptionRefusal} exists for that collision. There is no
 * such measurement for `triage`, and {@link ensureWorkspace}'s own docblock says
 * why that matters — the guard is opt-in *"because the hazard is not
 * universal"*, and *"a guard that fires on the healthy case is one that gets
 * deleted."*
 *
 * The honest reading of the risk is also smaller than it first looks. ADOPTION
 * ALONE DESTROYS NOTHING: the adoption arm selects the workspace and returns,
 * and the two operations that would damage somebody's window — `--recreate`,
 * which closes it, and `--restart <id>`, which respawns a pane — are both flags
 * an operator types. The guard's value is in catching the collision BEFORE they
 * reach for one, which is a `scripts/triage` concern and is where §6.10 scoped
 * the refusal for `review` too.
 *
 * ## What WOULD change this, stated so the silence is not read as coverage
 *
 * A `triage` workspace observed on a machine that this console did not build.
 * At that point the guard is one closure argument — `ensureWorkspace` already
 * takes it, and takes it as a parameter precisely so the console-shaped policy
 * can live with the console — and the change is `ensureReview`'s three lines.
 * What it must NOT become is a branch inside `ensureWorkspace` on which console
 * is asking.
 *
 * One asymmetry pulls the other way and is recorded rather than acted on: this
 * is the console nobody is waiting on. A `review` mis-adoption is four wrong
 * panes in front of a person who just asked for a review; a `triage`
 * mis-adoption is TWO wrong panes under a clock that goes on sweeping. That
 * raises the cost of being wrong here without raising the evidence that it will
 * happen, which is the trade this decision takes.
 */
export async function ensureTriage(
  client: CmuxClient,
  opts: OperationsPlanOptions,
  recreate = false,
): Promise<EnsureResult> {
  return ensureWorkspace(client, TRIAGE_SPEC, opts, recreate);
}
