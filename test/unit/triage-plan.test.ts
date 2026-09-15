/**
 * The `triage` console's plan — ONE collator over SIX observers, in two rows
 * of three, and NOT ONE keyboard between them.
 *
 * **THIS HEADER DESCRIBED A TWO-SEAT CONSOLE UNTIL 2026-09-13, THEN A
 * FOUR-SEAT ONE UNTIL 2026-09-15, and is corrected here rather than quietly
 * replaced**, because how it rotted each time is the more useful half. It
 * said "a reconciler and an observer", "the two seats are `tri-1`, `obs-t1`",
 * "all three square consoles share `agentSquarePanes`", then "the four seats
 * are `tri-1`, `obs-t1`, `obs-t2`, `obs-t3`" and "the two consoles share
 * their pane builder outright". Every one of those was true when written.
 * The console grew from a pair, to a square, to its own four-seat table, to
 * SRD-TRIAGE-MIXED-OBSERVERS §4.2's seven-seat one — and the describe blocks
 * below were all updated while this header was not, because nothing a header
 * says is executable. A file's prose is the part with no test.
 *
 * ## What this file is for
 *
 * `triagePanes` stopped sharing a builder with any sibling console on
 * 2026-09-13 and has not gone back since: it took its own hardcoded table
 * that day, at four seats, and kept one growing to seven
 * (SRD-TRIAGE-MIXED-OBSERVERS §4.2). So a runtime comparison against
 * `reviewPanes` can no longer do this file's job — see "the anti-vacuity pin"
 * below for what replaced it. What is THIS console's alone:
 *
 *  - **The seven seats are `tri-1`, `obs-t1`, `obs-td1`, `obs-t2`, `obs-t3`,
 *    `obs-td2`, `obs-tv1`, in CREATION order** (§4.2's order, not the owner's
 *    reading order — {@link triagePanes}' own docblock carries the reason).
 *    Asserted by NAME and in ORDER, never as a count: "seven panes" passes on
 *    the wrong seven, and the wrong seven here is not hypothetical — it is the
 *    OLD four-seat default, which is exactly what this file's refusal test
 *    below feeds back in.
 *  - **The plan defaults to NO KEYBOARD.** `development` and `review` are four
 *    attended panes and therefore four runs; this console is one run of `rpc`
 *    seats, because `tui` allocates no epoch and a console that dispatches
 *    many times a day cannot afford a sweep that runs twice
 *    (SRD-TRIAGE-CONSOLE §2.3). `tuiWorkers` is a CALLER's argument, so the plan
 *    cannot enforce that — what it owns, and what is pinned below, is the
 *    default with none named. This is the one item on this list that still
 *    separates it from `review`, which is four keyboards.
 *  - **A fourth distinct workspace name**, one of the four CONSOLES this
 *    repository builds. Adoption is an exact title match, so four consoles
 *    that shared a name would each adopt the others.
 *  - **`TRIAGE_TOP_FRACTION` is `1/3`**, and `TRIAGE_OBSERVER_ROW_FRACTION` is
 *    `1/2`, splitting the two observer rows evenly beneath it. Both were
 *    `null`/unset while the console had fewer rows than it does now; a
 *    fraction moves the border between two ROWS, and this console has had a
 *    second one to move only since 2026-09-13 and a third since 2026-09-15.
 *
 * ## The anti-vacuity pin, now that there is no shared builder to lean on
 *
 * `triagePanes` at seven workers is a HARDCODED table, transcribed from
 * SRD-TRIAGE-MIXED-OBSERVERS §4.2 rather than computed or delegated. A
 * faithful hand copy of that table would be INDISTINGUISHABLE from the real
 * thing on the day it is written and would pass every literal assertion in
 * this file; it only diverges the day the SRD's own shape moves and one copy
 * follows it. So the seven-pane describe block below anchors the table as a
 * LITERAL (`"matches SRD §4.2's split table literally"`) and separately
 * replays it into rows, which is what catches the mutation that actually
 * happens: an anchor copied off by one, silently yielding a wide row where
 * two were meant (`"SRD §11 task 1.1's revert check"`, further down).
 *
 * **A cross-console comparison against `reviewPanes` used to carry this job,
 * for one day, and cannot any more.** While both consoles delegated to
 * `collatorOverRowPanes`, agreement on a shared worker set was the
 * load-bearing probe: a swap of one plan for the other was invisible to every
 * shape assertion in this file. `triagePanes` took its own table the same day
 * and never gave it back, and the two plans cannot be made to agree at ANY
 * worker count any more — `triagePanes` now refuses anything other than
 * exactly seven, and `collatorOverRowPanes` (`reviewPanes`'s builder) tops out
 * at four. What replaced the comparison is the literal table above plus the
 * asymmetric-defaults probe below, neither of which depends on a neighbour
 * holding still.
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
  reviewPanes,
  triagePanes,
} from "../../src/backends/cmux/operations-plan.ts";
import { parseConfig } from "../../src/config/load.ts";
import { OBSERVER_DOCKER_ROLE, OBSERVER_K8S_ROLE, OBSERVER_VM_ROLE } from "../../src/config/schema.ts";
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
  it("names the collator first, then its observers in CREATION order — SRD §4.2, D3", () => {
    /*
     * THE ORDER IS THE LAYOUT, not a grouping preference, and — new as of
     * seven seats — it is not READING order either. `triagePanes`' own table
     * opens both observer rows (`down` off pane 0, then `down` off pane 1)
     * before either row is split into columns, so this array reads `tri-1,
     * obs-t1, obs-td1, obs-t2, obs-t3, obs-td2, obs-tv1` — row two's first
     * seat created before row one's second and third — even though the
     * console DISPLAYS row one (`obs-t1, obs-t2, obs-t3`) above row two
     * (`obs-td1, obs-td2, obs-tv1`). {@link triagePanes}'s own docblock
     * carries the full explanation; this test only has to agree with it.
     *
     * The collator must still come FIRST — put any observer there and it is
     * the one that spans the width.
     */
    expect([...DEFAULT_TRIAGE_WORKERS]).toEqual([
      "tri-1",
      "obs-t1",
      "obs-td1",
      "obs-t2",
      "obs-t3",
      "obs-td2",
      "obs-tv1",
    ]);
  });

  it("titles panes by WORKER ID — the seven named seats, in CREATION order", () => {
    // A role title would print `observer` on SIX of the seven panes, which is
    // worse than the three it would have printed at four seats: the whole
    // point of the two observer rows is that each seat holds a different
    // slice of a different kind of target, and a title that cannot tell them
    // apart is a pane an operator cannot map to a container. The id is also
    // what `dispatch --worker` takes, so the title is the argument.
    expect(unattended().map((p) => p.title)).toEqual([
      "tri-1",
      "obs-t1",
      "obs-td1",
      "obs-t2",
      "obs-t3",
      "obs-td2",
      "obs-tv1",
    ]);
  });

  it("refuses the OLD four-seat default outright — the four-worker branch is gone", () => {
    // If `triagePanes`' old `workers.length === 4` branch ever comes back,
    // this exact array is what it used to accept and build via
    // `collatorOverRowPanes`. Naming the OLD ids, not synthetic ones, is the
    // point: a synthetic four-length array would pass just as well against a
    // reintroduced branch, but only the real old default proves nobody
    // quietly special-cased it back in by name.
    expect(() =>
      triagePanes({ ...BASE, workers: ["tri-1", "obs-t1", "obs-t2", "obs-t3"] }),
    ).toThrow(/^triage: refusing 4 workers — the console holds exactly seven workers/);
  });

  /**
   * `tri-1` lands the operator, on the collator's precedent and for a weaker
   * reason: nobody DRIVES this console by typing, but somebody debugs it, and
   * the reconciler is the seat holding what the other six feed.
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
 * THE ANTI-VACUITY BLOCK: does this plan build ITS OWN shape, or a
 * neighbour's?
 *
 * **RETIRED THE CROSS-CONSOLE COMPARISON ON 2026-09-15, AND THIS TIME FOR
 * GOOD.** Earlier revisions of this block pinned `triagePanes` against
 * `reviewPanes` on one SHARED worker set — first asserting agreement while
 * both delegated to `agentSquarePanes`, then disagreement for one day once
 * `triagePanes` took its own four-seat table, then agreement again once
 * `review` was asked to share that table through `collatorOverRowPanes`.
 * Every one of those was true when written; the file header carries the full
 * sequence. That comparison is not merely stale now, it is UNRUNNABLE:
 * `triagePanes` refuses anything other than exactly seven workers and
 * `collatorOverRowPanes` (`reviewPanes`'s builder) tops out at four, so no
 * worker set exists any more that both plans would even accept, let alone
 * agree on.
 *
 * What replaces it is the lesson the earlier inversions already taught: a
 * probe of the form *"this console does / does not match that one"* is a
 * claim about a NEIGHBOUR, not about this console, and it is worth only what
 * the neighbour's own shape happens to be worth on the day it runs. The
 * LITERAL anchor table in the seven-pane describe block further down (§4.2's
 * split table, transcribed) is what actually pins this console's shape now,
 * and it does not move when any other console does. What is left here is the
 * two probes that never depended on a neighbour holding still: the
 * asymmetric defaults (this console and `review` share no default seat) and
 * the label inside a refusal (this console never claims to be `review` when
 * it fails).
 */
describe("the triage plan is not, and cannot be made to look like, the review plan", () => {
  /**
   * THE ASYMMETRIC FIXTURE. If this console's defaults ever came to agree
   * with `review`'s, a mutation that replaced `triagePanes`' body outright
   * with `reviewPanes(opts)` would be invisible everywhere else in this file
   * — the titles would be equal by construction. This is the probe that
   * makes them disagree, stated as its own assertion rather than left
   * implicit in the seat names above.
   */
  it("does NOT agree with the review console on the defaults, which is what makes the anchor table mean anything", () => {
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
    // Even with no worker count left that both builders would accept, both
    // refusals are still reachable on an empty set, and the label is still
    // the only thing that tells an operator which `--workers` flag to go
    // and fix.
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
 * the ignore**: all seven triage seats ARE in `fleet.example.yaml`, so the pane
 * plan can be checked against the shipped reference config itself — no skip, no
 * machine dependency, and nothing that has to be true of the operator's live
 * fleet for this file to mean what it says.
 *
 * Without this, `DEFAULT_TRIAGE_WORKERS` is a second spelling of the console's
 * membership and the two drift silently: the plan decides which seven workers
 * `scripts/triage` STARTS, and the config decides which seven exist. A seat
 * renamed in one and not the other is a pane whose `up` refuses on an unknown
 * worker — a failure that arrives twice over, once per side, in a pane nobody
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
     * pane 1, and would be briefed a reconciliation it has no prompt for. The
     * four roles (`triage`, `observer-k8s`, `observer-docker`, `observer-vm`)
     * are what tells a k8s seat from a docker or vm one, since the ids alone
     * (`obs-t1` vs `obs-td1` vs `obs-tv1`) are a naming convention, not a
     * schema fact.
     */
    expect([...DEFAULT_TRIAGE_WORKERS].map((id) => [id, roles.get(id)])).toEqual([
      ["tri-1", "triage"],
      ["obs-t1", OBSERVER_K8S_ROLE],
      ["obs-td1", OBSERVER_DOCKER_ROLE],
      ["obs-t2", OBSERVER_K8S_ROLE],
      ["obs-t3", OBSERVER_K8S_ROLE],
      ["obs-td2", OBSERVER_DOCKER_ROLE],
      ["obs-tv1", OBSERVER_VM_ROLE],
    ]);
  });
});

/**
 * THE SEVEN-PANE SHAPE (SRD-TRIAGE-MIXED-OBSERVERS §4.2) — the ONLY geometry
 * `triagePanes` builds now that the four-worker branch is gone (§11 task
 * 2.1). This block still uses SYNTHETIC ids that name their own final cell
 * rather than the real roster: the tests above already pin
 * `DEFAULT_TRIAGE_WORKERS` by name, so repeating the same seven real ids here
 * would test nothing new about the GEOMETRY — a synthetic id that names its
 * own cell (`r1c2`, `r2c3`, …) makes a wrong anchor visible at the site of
 * the mistake instead of requiring a cross-reference back to §4.2's table.
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
