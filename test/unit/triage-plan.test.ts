/**
 * The `triage` console's plan — ONE collator over THREE observers, and NOT ONE
 * keyboard between them.
 *
 * **THIS HEADER DESCRIBED A TWO-SEAT CONSOLE UNTIL 2026-09-13 and is corrected
 * here rather than quietly replaced**, because how it rotted is the more useful
 * half. It said "a reconciler and an observer", "the two seats are `tri-1`,
 * `obs-t1`", "all three square consoles share `agentSquarePanes`" and
 * "`TRIAGE_TOP_FRACTION` is `null`". Every one of those was true when written.
 * The console then grew to four seats, left the square, and took a fraction —
 * and the describe blocks below were all updated while this header was not,
 * because nothing a header says is executable. A file's prose is the part with
 * no test.
 *
 * ## What this file is for that `review-plan.test.ts` is not
 *
 * The two consoles share their pane builder outright — `collatorOverRowPanes`,
 * since `review` took this shape on 2026-09-13 — so the one-over-N split table
 * is decided once, there. What is THIS console's alone is everything the shared
 * builder cannot see:
 *
 *  - **The four seats are `tri-1`, `obs-t1`, `obs-t2`, `obs-t3`.** Asserted by
 *    NAME and in ORDER, never as a count. "Four panes" passes on the wrong four,
 *    and the wrong four here is not hypothetical — the consoles are one function
 *    call apart and differ only in the constant they name.
 *  - **The plan defaults to NO KEYBOARD.** `development` and `review` are four
 *    attended panes and therefore four runs; this console is one run of `rpc`
 *    seats, because `tui` allocates no epoch and a console that dispatches
 *    288 times a day cannot afford a sweep that runs twice
 *    (SRD-TRIAGE-CONSOLE §2.3). `tuiWorkers` is a CALLER's argument, so the plan
 *    cannot enforce that — what it owns, and what is pinned below, is the
 *    default with none named. This is the one item on this list that still
 *    separates it from `review`, which is four keyboards.
 *  - **A fourth distinct workspace name.** Adoption is an exact title match, so
 *    four consoles that shared a name would each adopt the others.
 *  - **`TRIAGE_TOP_FRACTION` is `1/3`**, and so is
 *    `TRIAGE_OBSERVER_WIDTH_FRACTION`. Both were `null` while the collator
 *    shared its row; a fraction moves the border between two ROWS, and there was
 *    no second row to move. There is now, and `review` carries the same pair for
 *    the same reason.
 *
 * ## The anti-vacuity pin, and why a cross-console comparison is not enough
 *
 * At four workers `triagePanes` is one line delegating to `collatorOverRowPanes`,
 * and the value of that — SRD-TRIAGE-CONSOLE D5's bet that a console is a DATA
 * addition — is entirely in the delegation. A hand-rolled copy of the split
 * table here would be INDISTINGUISHABLE from the delegation on the day it was
 * written and would pass every literal assertion in this file. (At seven
 * workers — SRD-TRIAGE-MIXED-OBSERVERS §4.2 — the function takes its own
 * hardcoded table instead, on purpose; see the seven-pane describe block
 * below.)
 *
 * So the shape is asserted BOTH ways: as a literal anchor table, and against a
 * sibling AT RUNTIME on one shared worker set. The runtime comparison is the one
 * a copy fails — not on the day it is made, but on the day the shared table
 * moves and only one console follows it.
 *
 * **WHICH sibling is the part that had to change, and the lesson is general.**
 * That comparison pointed at `reviewPanes` and asserted agreement; then, for one
 * day, disagreement; it now asserts agreement again, because `review` came back
 * to this shape through a different builder. A "does this match that console"
 * probe is a claim about a NEIGHBOUR and inverts whenever the neighbour moves,
 * while telling you nothing about whether this console is still right. So the
 * LITERAL table is the load-bearing assertion here, and the runtime comparison
 * that still detects a re-delegation to the square is aimed at `development` —
 * the one console that has not changed shape.
 *
 * **THAT LIMIT IS MEASURED, not assumed, and it is stated here so nobody reads
 * this block as stronger than it is.** Two mutations, 2026-09-06:
 *
 *  - `triagePanes` replaced by a FAITHFUL hand copy of the square — the split
 *    table transcribed correctly — **survives this whole file green**. Identical
 *    output is identical output, and no test can see the difference.
 *  - The same faithful copy, with `agentSquarePanes`' own table then edited
 *    underneath it, is **RED** on both probes below.
 *
 * So this is a time-delayed detector rather than an instantaneous one, and that
 * is the most any test can be here. The mutation it does catch outright is the
 * one that actually happens: a copy made with the anchor wrong — pane 4 split
 * off its predecessor rather than off pane 2, which silently yields a 3+1 column
 * — is red immediately.
 *
 * ## The asymmetric fixture, and why it is now the whole guarantee
 *
 * Every probe below that could be satisfied by `reviewPanes` is checked on a
 * fixture where the two consoles DISAGREE — the default worker sets, and the
 * console name inside the refusals. A file whose every fixture made the two
 * plans agree would survive a mutation that swapped one for the other, which is
 * the exact mutation this console's one-line plan invites.
 *
 * **This was belt-and-braces when it was written and is LOAD-BEARING now.** The
 * two consoles share a builder again, so on any shared worker set they produce
 * byte-identical panes: `triagePanes` replaced outright by `reviewPanes(opts)`
 * is invisible to every shape assertion in this file. The ONLY things that still
 * catch it are the default worker sets (`tri-1, obs-t*` versus `col-1, rev-*`,
 * with no seat in common) and the label inside the refusal. Both are asserted
 * explicitly below rather than left implicit in the seat names, precisely
 * because they are now the last line of defence rather than a second one.
 */

import { describe, expect, it } from "bun:test";

import {
  DEFAULT_REVIEW_WORKERS,
  DEFAULT_TRIAGE_WORKERS,
  DEVELOPMENT_WORKSPACE,
  OPERATIONS_TOP_FRACTION,
  OPERATIONS_WORKSPACE,
  REVIEW_WORKSPACE,
  TRIAGE_TOP_FRACTION,
  TRIAGE_WORKSPACE,
  developmentPanes,
  reviewPanes,
  triagePanes,
} from "../../src/backends/cmux/operations-plan.ts";
import { parseConfig } from "../../src/config/load.ts";
import { OBSERVER_K8S_ROLE } from "../../src/config/schema.ts";
import { ROOT, exampleConfig } from "../support/role-docs.ts";

const REPO = "/repo";
const BASE = { repoRoot: REPO, watchDir: "/work" } as const;

/**
 * The console as the driver will actually ask for it: no `tuiWorkers`.
 *
 * `review-plan.test.ts`'s equivalent helper passes `tuiWorkers:
 * DEFAULT_REVIEW_WORKERS`, because that console is four keyboards. The
 * difference between the two helpers IS the difference between the two consoles,
 * which is why this one takes no argument rather than defaulting to one.
 */
const unattended = () => triagePanes(BASE);

describe("the triage console is a collator across the top, its observers beneath", () => {
  it("is a distinct workspace from all three other consoles", () => {
    expect(TRIAGE_WORKSPACE).toBe("triage");
    expect(TRIAGE_WORKSPACE).not.toBe(REVIEW_WORKSPACE);
    expect(TRIAGE_WORKSPACE).not.toBe(DEVELOPMENT_WORKSPACE);
    expect(TRIAGE_WORKSPACE).not.toBe(OPERATIONS_WORKSPACE);
  });

  /**
   * THE SEATS BY NAME, which is the assertion this file exists for.
   *
   * Not a count, and not a length. Three consoles are built from one constant
   * each, so a matching shape is true of more than one of them and pins none by
   * itself — a `triagePanes` handed `DEFAULT_REVIEW_WORKERS` would satisfy every
   * structural probe in this file and stand up the wrong fleet.
   *
   * **This header said "THE TWO SEATS BY NAME" while asserting four**, and had
   * done since the console grew its second pair. A count in prose above a list
   * in code is the cheapest thing in this file to get wrong and the last thing
   * anything checks — which is the argument for naming seats rather than
   * counting them, made accidentally by the comment that was counting.
   */
  it("names the collator first, then its three observers, in pane order", () => {
    /*
     * THE ORDER IS THE LAYOUT, not a grouping preference. `triagePanes` splits
     * `[null, down-from-0, right-from-1, right-from-2]`: pane 1 takes the
     * initial surface, pane 2 splits DOWN to open the observer row, and the rest
     * walk right along it. So the collator must come FIRST — put any observer
     * there and it is the one that spans the width.
     *
     * The rule this replaces was the 2x2's, where the order carried the PAIRING:
     * collators first so `obs-t1` fell under `tri-1`. Same constant, same kind of
     * constraint, different table — which is why it is spelled out here rather
     * than cross-referenced.
     */
    expect([...DEFAULT_TRIAGE_WORKERS]).toEqual(["tri-1", "obs-t1", "obs-t2", "obs-t3"]);
  });

  it("titles panes by WORKER ID — the four named seats, in order", () => {
    // A role title would print `observer` on THREE of the four panes, which is
    // worse than the two it would have printed on the 2x2: the whole point of
    // the bottom row is that its seats hold different slices, and a title that
    // cannot tell them apart is a pane an operator cannot map to a container.
    // The id is also what `dispatch --worker` takes, so the title is the
    // argument.
    expect(unattended().map((p) => p.title)).toEqual(["tri-1", "obs-t1", "obs-t2", "obs-t3"]);
  });

  /**
   * `tri-1` lands the operator, on the collator's precedent and for a weaker
   * reason: nobody DRIVES this console by typing, but somebody debugs it, and
   * the reconciler is the seat holding what the other three feed.
   *
   * Both halves are asserted. `split: null` is the pane that consumes the
   * workspace's initial surface and the one `createWorkspace` focuses, so index
   * alone would survive a builder that focused elsewhere.
   */
  it("puts the reconciler in pane 1, the seat that gets focus", () => {
    const panes = unattended();
    expect(panes[0]!.title).toBe("tri-1");
    expect(panes[0]!.split).toBeNull();
  });

  /**
   * THE DEFAULT IS NO KEYBOARD, and this is the probe that separates this
   * console from its two square siblings on the property that decides its whole
   * design.
   *
   * `--attach-here` is what makes a pane Pi's own interface and what makes the
   * seat `tui` in practice; SRD-TRIAGE-CONSOLE §2.3 enumerates what `tui` costs
   * a scheduler, and the load-bearing item is that it allocates no epoch, so a
   * re-dispatched sweep runs twice. `dispatch --auto` refuses a `tui` worker
   * outright for a related reason.
   *
   * **The plan cannot ENFORCE this and the test does not claim it does.**
   * `tuiWorkers` is the caller's, and the enforcement lives in the config (both
   * seats resolve to `pane_mode: rpc` from their roles) and in `up`'s own
   * one-tui-worker guard. What is asserted is the DEFAULT: ask for this console
   * and name nobody, and you get two views.
   */
  it("gives no pane a keyboard when the caller names no tui workers", () => {
    for (const p of unattended()) {
      expect(p.command, `${p.title} was handed a keyboard`).not.toContain("'--attach-here'");
      expect(p.command, `${p.title} was handed a keyboard`).not.toContain("'--attach-clear'");
    }
  });

  /**
   * A CONSEQUENCE OF THE ABOVE, recorded here rather than discovered later.
   *
   * `agentPaneCommand` gates `--workspace-name` on `attach` — a non-attached
   * pane's `up` names its own workspace and `presentedWorkspace` discards the
   * flag, so emitting it would put a flag in the argv the receiver is documented
   * to ignore. Every seat in this console is unattended, so **no pane in it ever
   * carries `--workspace-name`**, and the monitor heads this console's group
   * with the workspace ref rather than with `workspace triage`.
   *
   * That is a real cosmetic limit and it is this console's alone: `development`
   * and `review` are attended throughout and always carry it. Pinned so the
   * absence reads as understood rather than as a plan that forgot.
   */
  it("carries no --workspace-name, because the flag rides with a keyboard", () => {
    for (const p of triagePanes({ ...BASE, workspaceName: TRIAGE_WORKSPACE })) {
      expect(p.command).not.toContain("'--workspace-name'");
    }
  });

  it("gives the collator ONE THIRD of the height, because the rows are UNLIKE", () => {
    /*
     * **THIS ASSERTED `null` UNTIL 2026-09-13, and it was right to.** While the
     * console was one row — `tri-1` beside its observer — `applyTopFraction` had
     * no border between rows to move, so a value here could not express the
     * preference anyone would reach for it to state. That is why the old test
     * name said the halves were left alone.
     *
     * `triagePanes` now builds the collator full-width over a row of three, so
     * there IS a border and the fraction means something. The rows are genuinely
     * unlike — one settled document above, three observers working concurrent
     * slices below — which is `OPERATIONS_TOP_FRACTION`'s situation rather than
     * `review`'s "nothing to favour".
     *
     * Still compared against `OPERATIONS_TOP_FRACTION`: the two consoles want
     * different numbers for different reasons, and asserting they differ is what
     * stops this one being "fixed" by copying that one.
     */
    expect(TRIAGE_TOP_FRACTION).toBeCloseTo(1 / 3, 10);
    expect(TRIAGE_TOP_FRACTION).not.toBe(OPERATIONS_TOP_FRACTION);
  });

  it("refuses a fifth pane, naming ITS OWN console in the refusal", () => {
    // The builder is shared by three consoles, so the label is the only thing in
    // the message that tells an operator which `--workers` flag to go and fix.
    expect(() =>
      triagePanes({ ...BASE, workers: ["tri-1", "obs-t1", "obs-t2", "obs-t3", "obs-t4"] }),
    ).toThrow(/^triage: refusing 5 workers/);
  });

  it("refuses an empty worker set, naming ITS OWN console", () => {
    expect(() => triagePanes({ ...BASE, workers: [] })).toThrow(/^triage: .*at least one worker/);
  });
});

/**
 * THE ANTI-VACUITY BLOCK: does this plan build ITS OWN shape, or the square's?
 *
 * **RE-AIMED 2026-09-13, AND THE PREMISE IS NOW INVERTED.** This block used to
 * pin `triagePanes` BYTE-IDENTICAL to `reviewPanes` on a shared worker set,
 * because the two consoles genuinely shared `agentSquarePanes` and the risk
 * worth guarding was a hand copy that would drift the day the shared table
 * changed. `triagePanes` stopped delegating when this console became one
 * collator over three observers: the square's table makes pane 2 the top row's
 * second half, so pane 1 can never be full width, and no shorter or longer
 * worker list changes that. The shape differs, not merely the count.
 *
 * **THIS GUARD HAS NOW BEEN POINTED THREE WAYS IN ONE DAY, and the sequence is
 * the finding.** It asserted the two consoles AGREE, while both delegated to
 * `agentSquarePanes`. It was inverted to assert they DISAGREE, when
 * `triagePanes` took its own table on 2026-09-13. It is inverted BACK here,
 * because `review` was asked to take this console's shape later the same day and
 * both now delegate to `collatorOverRowPanes`.
 *
 * **Every one of the three was true when it was written.** None was a mistake,
 * and nothing reddened at either inversion until the assertion itself went red.
 * That is the defect worth naming: an assertion of the form *"this console does
 * / does not match that one"* is a claim about a NEIGHBOUR. It flips whenever
 * the neighbour moves, and in neither direction does it tell you whether THIS
 * console is still right — `tri-1` could stop spanning the width and a
 * disagreement probe would stay happily green.
 *
 * So the load-bearing assertion below is the ANCHOR TABLE, written as a literal:
 * the collator full width, its observers in one row beneath it. That is what an
 * operator would notice breaking, and it does not move when `review` changes its
 * mind. The cross-console comparisons are kept but demoted to what they can
 * honestly do — one documents that the sharing is real, and one is re-aimed at
 * `development`, which did NOT change shape and therefore still catches a
 * re-delegation to the square. Anti-vacuity is carried by the asymmetric-defaults
 * probe further down, which never depended on the two consoles differing at all.
 */
describe("the triage plan anchors a full-width collator over one row of observers", () => {
  /**
   * ONE WORKER SET, BOTH CONSOLES — kept from the version this replaces, and
   * for a reason that survived the inversion: with the defaults removed from the
   * picture, everything left is the BUILDER's decision. It used to prove the two
   * agree; it now proves they cannot be made to.
   */
  const SHARED = ["w-1", "w-2", "w-3", "w-4"] as const;

  it("produces the review console's panes on a shared set, because they share a builder", () => {
    /*
     * INVERTED BACK on 2026-09-13, hours after being inverted TO `not.toEqual`.
     * For one day `triagePanes` carried its own copy of the table and the two
     * consoles could not be made to match; `review` was then asked to take this
     * shape, the table moved into `collatorOverRowPanes`, and they are equal
     * again on any set where the defaults are out of the picture.
     *
     * **This assertion can no longer catch a re-delegation to
     * `agentSquarePanes`, and it does not pretend to** — that job belongs to the
     * literal table in the next test, and to the `development` comparison
     * beside it. What this one still buys is that the sharing is REAL rather
     * than incidental: give either console its own table again and this reddens.
     */
    expect(triagePanes({ ...BASE, workers: SHARED })).toEqual(
      reviewPanes({ ...BASE, workers: SHARED }),
    );
  });

  it("anchors a full-width collator over one row of observers", () => {
    /*
     * THE ANCHOR TABLE IS THE WHOLE TEST, exactly as it was before — only the
     * table changed. Read against `triagePanes`' own diagram:
     *
     *   1: the initial surface
     *   2: "down"  off 1  (splitFrom 0)   <- creates the observer row
     *   3: "right" off 2  (splitFrom 1)   <- walks along it
     *   4: "right" off 3  (splitFrom 2)
     *
     * The FIRST split is the load-bearing one: it must go `down` off pane 1, or
     * the top row is divided and the collator never spans the width. Every
     * count, title and command assertion in this file passes either way.
     */
    const shape = (panes: ReturnType<typeof triagePanes>) =>
      panes.map((p) => [p.split, p.splitFrom ?? null]);

    expect(shape(triagePanes({ ...BASE, workers: SHARED }))).toEqual([
      [null, null],
      ["down", 0],
      ["right", 1],
      ["right", 2],
    ]);
    /*
     * …and the SQUARE's table, read at runtime, is still a different one.
     *
     * RE-AIMED 2026-09-13 from `reviewPanes` to `developmentPanes`. It pointed
     * at `review` while that console was the square; `review` has since taken
     * THIS console's shape, so the two now agree and the comparison could no
     * longer detect anything. `development` did not move, and it is the only
     * remaining console on `agentSquarePanes` — which makes it the right
     * neighbour for this probe and, incidentally, the reason that builder still
     * exists.
     *
     * This is what catches a re-delegation of `triagePanes` to the square: the
     * literal table above and this line stop disagreeing together, and both
     * reds point at the same edit.
     */
    expect(shape(triagePanes({ ...BASE, workers: SHARED }))).not.toEqual(
      shape(developmentPanes({ ...BASE, workers: SHARED })),
    );
  });

  /**
   * THE ASYMMETRIC FIXTURE, and the reason the block above uses `SHARED` rather
   * than the defaults.
   *
   * If every fixture in this file made the two consoles agree, a mutation that
   * replaced `triagePanes`' body with `reviewPanes(opts)` would survive the
   * whole battery — the plans would be equal by construction and every probe
   * would be measuring nothing. This is the probe that makes them disagree, and
   * it is stated as its own assertion rather than left implicit in the seat
   * names above so that the guarantee is visible to the next reader.
   */
  it("does NOT agree with the review console on the defaults, which is what makes the rest mean anything", () => {
    const triageTitles = triagePanes(BASE).map((p) => p.title);
    const reviewTitles = reviewPanes(BASE).map((p) => p.title);

    expect(triageTitles).not.toEqual(reviewTitles);
    expect(triageTitles).toEqual([...DEFAULT_TRIAGE_WORKERS]);
    expect(reviewTitles).toEqual([...DEFAULT_REVIEW_WORKERS]);
    // No seat is shared either. Two consoles sharing a worker would be two runs
    // holding one container, and `dispatch-request.test.ts` pins the same
    // property for the two ROSTERS — this is the layout half of it.
    const review = new Set(DEFAULT_REVIEW_WORKERS);
    expect([...DEFAULT_TRIAGE_WORKERS].filter((id) => review.has(id))).toEqual([]);
  });

  it("names its own console, not the review console, in a refusal", () => {
    // The other half of the asymmetry, and the shared builder makes it MORE
    // valuable rather than less: `collatorOverRowPanes` takes the label as an
    // argument and BOTH consoles now pass through it, so a swapped constant
    // shows up here and nowhere in the layout — the layouts are identical.
    expect(() => triagePanes({ ...BASE, workers: [] })).toThrow(/^triage:/);
    expect(() => triagePanes({ ...BASE, workers: [] })).not.toThrow(/^review:/);
  });
});

/**
 * THE SEATS, READ OUT OF THE TRACKED CONFIG — hermetic, and ungated.
 *
 * `review-plan.test.ts` gates its equivalent block on `existsSync(fleet.yaml)`,
 * because none of `col-1`, `rev-arch-1`, `rev-ctx-1` or `rev-lang-1` is declared
 * in `fleet.example.yaml` — those seats exist only in the live `fleet.yaml`.
 * HALF of that gate's original reason is now gone: `fleet.yaml` was gitignored
 * when the gate was written and has been TRACKED since 2026-09-12, so the
 * `existsSync` is satisfied on every clean checkout and in CI, and the block it
 * guards no longer skips anywhere. The gate is vestigial rather than wrong, and
 * retiring it belongs to that file, not to this one.
 *
 * **This console needs no gate at all, and for a reason that never depended on
 * the ignore**: all four triage seats ARE in `fleet.example.yaml`, so the pane
 * plan can be checked against the shipped reference config itself — no skip, no
 * machine dependency, and nothing that has to be true of the operator's live
 * fleet for this file to mean what it says.
 *
 * Without this, `DEFAULT_TRIAGE_WORKERS` is a second spelling of the console's
 * membership and the two drift silently: the plan decides which two workers
 * `scripts/triage` STARTS, and the config decides which two exist. A seat
 * renamed in one and not the other is two panes whose `up` refuses on an
 * unknown worker — a failure that arrives twice over, in two panes nobody
 * is watching.
 */
describe("the seats the plan names are the seats the tracked config declares", () => {
  it("declares every seat, with the role the console's design assigns it", async () => {
    const { config } = await parseConfig(exampleConfig(), `${ROOT}fleet.example.yaml`);
    const roles = new Map(config.workers.map((w) => [w.id, w.role]));

    /*
     * BY ID AND BY ROLE, in pane order. The id alone would pass on a `tri-1`
     * demoted to `observer-k8s`, which is the more likely edit and the more
     * confusing outcome — the reconciler seat would still be found, still be
     * pane 1, and would be briefed a reconciliation it has no prompt for.
     */
    expect([...DEFAULT_TRIAGE_WORKERS].map((id) => [id, roles.get(id)])).toEqual([
      ["tri-1", "triage"],
      ["obs-t1", OBSERVER_K8S_ROLE],
      ["obs-t2", OBSERVER_K8S_ROLE],
      ["obs-t3", OBSERVER_K8S_ROLE],
    ]);
  });
});

/**
 * THE SEVEN-PANE SHAPE (SRD-TRIAGE-MIXED-OBSERVERS §4.2) — a second geometry
 * `triagePanes` builds, on a worker count the four-worker tests above never
 * exercise. `DEFAULT_TRIAGE_WORKERS` still names four ids, so this whole block
 * uses SYNTHETIC ids that name their own final cell rather than the real
 * roster — the roster move is a later phase (§11 task 1.1 does the geometry
 * only).
 *
 * Ids are given in CREATION order, which SRD §4.2 states is not reading
 * order: both `down` splits that open the two observer rows happen before
 * either row's own `right` splits, so a pane named for row two's first column
 * (`r2c1`) is created (index 2) before row one's second and third columns
 * (`r1c2`, `r1c3`, indices 3 and 4).
 */
const SEVEN = ["top", "r1c1", "r2c1", "r1c2", "r1c3", "r2c2", "r2c3"] as const;

/** A pane, reduced to exactly what a layout replay needs. */
type LaidOutPane = { readonly title: string; readonly split: string | null; readonly splitFrom?: number };

type UnitCell = { readonly left: number; readonly right: number; readonly top: number; readonly bottom: number };

/**
 * Replays `split`/`splitFrom` as a binary split tree over a unit square, the
 * way `new-split` actually behaves: `down` halves the anchor's cell top over
 * bottom (anchor keeps the top half, the new pane takes the bottom half);
 * `right` halves it left over right (anchor keeps the left half, the new pane
 * takes the right half). `splitFrom` undefined means "the previous pane",
 * matching {@link OperationsPane.splitFrom}'s own contract. `up`/`left` are
 * not a direction any builder in this file emits, so this throws on them
 * rather than guessing a meaning.
 */
function computeCells(panes: readonly LaidOutPane[]): UnitCell[] {
  const cells: UnitCell[] = [];
  panes.forEach((p, i) => {
    if (i === 0) {
      cells[0] = { left: 0, right: 1, top: 0, bottom: 1 };
      return;
    }
    const anchorIndex = p.splitFrom ?? i - 1;
    const anchor = cells[anchorIndex]!;
    if (p.split === "down") {
      const mid = (anchor.top + anchor.bottom) / 2;
      cells[i] = { ...anchor, top: mid };
      cells[anchorIndex] = { ...anchor, bottom: mid };
    } else if (p.split === "right") {
      const mid = (anchor.left + anchor.right) / 2;
      cells[i] = { ...anchor, left: mid };
      cells[anchorIndex] = { ...anchor, right: mid };
    } else {
      throw new Error(`computeCells: unsupported split direction ${String(p.split)}`);
    }
  });
  return cells;
}

/**
 * Rows in READING order: cells grouped by top edge (a row), each row ordered
 * by left edge, as arrays of titles. This is the probe that catches a single
 * wide row where two were expected — see the revert check below.
 */
function rowsOf(panes: readonly LaidOutPane[]): string[][] {
  const cells = computeCells(panes);
  const rows = new Map<number, { left: number; title: string }[]>();
  panes.forEach((p, i) => {
    const cell = cells[i]!;
    const key = Math.round(cell.top * 1e6);
    const row = rows.get(key) ?? [];
    row.push({ left: cell.left, title: p.title });
    rows.set(key, row);
  });
  return [...rows.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, entries]) => entries.sort((a, b) => a.left - b.left).map((e) => e.title));
}

/** Each row's total width — 1 means the row is genuinely full width. */
function rowWidthsOf(panes: readonly LaidOutPane[]): number[] {
  const cells = computeCells(panes);
  const rows = new Map<number, number>();
  cells.forEach((cell) => {
    const key = Math.round(cell.top * 1e6);
    rows.set(key, (rows.get(key) ?? 0) + (cell.right - cell.left));
  });
  return [...rows.entries()].sort(([a], [b]) => a - b).map(([, width]) => width);
}

describe("triagePanes builds a second, hardcoded shape at exactly seven workers", () => {
  it("returns seven panes named and ordered SEVEN, by title and by worker", () => {
    const panes = triagePanes({ ...BASE, workers: SEVEN });
    expect(panes).toHaveLength(7);
    expect(panes.map((p) => p.title)).toEqual([...SEVEN]);
    expect(panes.map((p) => p.worker)).toEqual([...SEVEN]);
  });

  it("matches SRD §4.2's split table literally", () => {
    const panes = triagePanes({ ...BASE, workers: SEVEN });
    expect(panes.map((p) => [p.split, p.splitFrom ?? null])).toEqual([
      [null, null],
      ["down", 0],
      ["down", 1],
      ["right", 1],
      ["right", 3],
      ["right", 2],
      ["right", 5],
    ]);
  });

  it("replays to one collator row and two full-width observer rows, in reading order", () => {
    const panes = triagePanes({ ...BASE, workers: SEVEN });
    expect(rowsOf(panes)).toEqual([["top"], ["r1c1", "r1c2", "r1c3"], ["r2c1", "r2c2", "r2c3"]]);

    // Full width means exactly that: every row's cells sum to 1, not merely a
    // count of three.
    for (const width of rowWidthsOf(panes)) expect(width).toBeCloseTo(1, 10);
  });

  it("SRD §11 task 1.1's revert check: the OLD flat-row table reads as ONE wide row, not two", () => {
    /*
     * The table `triagePanes` used to delegate to before this task —
     * `collatorOverRowPanes`'s own shape, `[null, down·0, right·1, right·2,
     * right·3, right·4, right·5]` — stretched over the same seven ids. This is
     * exactly the mutation task 1.1 names: pass the old flat-row order and the
     * two-row assertion above must be able to tell the difference.
     */
    const flat: LaidOutPane[] = [
      { title: "top", split: null },
      { title: "r1c1", split: "down", splitFrom: 0 },
      { title: "r2c1", split: "right", splitFrom: 1 },
      { title: "r1c2", split: "right", splitFrom: 2 },
      { title: "r1c3", split: "right", splitFrom: 3 },
      { title: "r2c2", split: "right", splitFrom: 4 },
      { title: "r2c3", split: "right", splitFrom: 5 },
    ];

    const rows = rowsOf(flat);
    expect(rows).not.toEqual([["top"], ["r1c1", "r1c2", "r1c3"], ["r2c1", "r2c2", "r2c3"]]);
    expect(rows).toEqual([["top"], ["r1c1", "r2c1", "r1c2", "r1c3", "r2c2", "r2c3"]]);
  });

  it.each([3, 5, 6, 8])("refuses %d workers, naming the console and the count", (n) => {
    const workers = Array.from({ length: n }, (_, i) => `w-${i}`);
    expect(() => triagePanes({ ...BASE, workers })).toThrow(
      new RegExp(`^triage: refusing ${n} workers`),
    );
  });

  it("gives no seven-pane a keyboard when the caller names no tui workers", () => {
    for (const p of triagePanes({ ...BASE, workers: SEVEN })) {
      expect(p.command, `${p.title} was handed a keyboard`).not.toContain("'--attach-here'");
    }
  });

  it("hands exactly the named seat a keyboard, and no other", () => {
    const panes = triagePanes({ ...BASE, workers: SEVEN, tuiWorkers: ["r2c2"] });
    for (const p of panes) {
      if (p.title === "r2c2") {
        expect(p.command).toContain("'--attach-here'");
      } else {
        expect(p.command, `${p.title} was handed a keyboard`).not.toContain("'--attach-here'");
      }
    }
  });

  it("refuses a worker id assertPlainValue refuses, on the seven-worker path too", () => {
    // A space fails PLAIN_VALUE_RE the same way it would on the four-worker
    // path — this branch has its own loop over `workers` and the same
    // guard could in principle have been dropped when the table was added.
    const workers = ["top", "r1c1", "r2c1", "not plain", "r1c3", "r2c2", "r2c3"];
    expect(() => triagePanes({ ...BASE, workers })).toThrow(/not a plain identifier/);
  });
});
