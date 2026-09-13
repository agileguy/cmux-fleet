/**
 * The `triage` console's plan — a reconciler and an observer, and NOT ONE
 * keyboard between them.
 *
 * ## What this file is for that `review-plan.test.ts` is not
 *
 * All three square consoles share their pane builder outright
 * (`agentSquarePanes`), so the 2x2 split table is decided once, there. What is
 * THIS console's alone is everything the shared builder cannot see, and on this
 * console that list is different from `review`'s in one way that matters:
 *
 *  - **The two seats are `tri-1`, `obs-t1`.** Asserted by
 *    NAME and in ORDER, never as a count. "Two panes" passes on the wrong two,
 *    and the wrong two here is not hypothetical — the three square consoles are
 *    one function call apart and differ only in the constant they name.
 *  - **The plan defaults to NO KEYBOARD.** `development` and `review` are four
 *    attended panes and therefore four runs; this console is one run of two
 *    `rpc` seats, because `tui` allocates no epoch and a console that dispatches
 *    288 times a day cannot afford a sweep that runs twice
 *    (SRD-TRIAGE-CONSOLE §2.3). `tuiWorkers` is a CALLER's argument, so the plan
 *    cannot enforce that — what it owns, and what is pinned below, is the
 *    default with none named.
 *  - **A fourth distinct workspace name.** Adoption is an exact title match, so
 *    four consoles that shared a name would each adopt the others.
 *  - **`TRIAGE_TOP_FRACTION` is `null`** for an argument that is not
 *    `REVIEW_TOP_FRACTION`'s. See that constant's docblock: a fraction moves the
 *    border between the two ROWS, and `tri-1` shares its row with `obs-t1`.
 *
 * ## The anti-vacuity pin, and why it is a cross-console comparison
 *
 * `triagePanes` is three lines delegating to `agentSquarePanes`, and the value
 * of that — SRD-TRIAGE-CONSOLE D5's bet that a fourth console is a DATA addition
 * — is entirely in the delegation. A hand-rolled copy of the split table here
 * would be INDISTINGUISHABLE from the delegation on the day it was written and
 * would pass every literal assertion in this file.
 *
 * So the shape is asserted against `reviewPanes` AT RUNTIME, on one shared
 * worker set, rather than against a literal. That is the assertion a copy fails:
 * not on the day it is made, but on the day `agentSquarePanes`' table moves and
 * only one of the two consoles follows it. The literal assertions stay too — the
 * cross-console one alone would be satisfied by two consoles that are equally
 * wrong.
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
 * ## The asymmetric fixture, written before the battery rather than after it
 *
 * Every probe below that could be satisfied by `reviewPanes` is checked on a
 * fixture where the two consoles DISAGREE — the default worker sets, and the
 * console name inside the refusals. A file whose every fixture made the two
 * plans agree would survive a mutation that swapped one for the other, which is
 * the exact mutation this console's three-line plan invites.
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
 * **The guard is still needed, pointed the other way.** The old equality was
 * what stopped a silent copy; with the equality gone, the same vacuity returns
 * unless something pins this console's OWN table. So these assertions now name
 * the collator-over-observers anchors explicitly AND assert the two consoles
 * DISAGREE — which is what catches a future edit that quietly re-delegates
 * `triagePanes` to `agentSquarePanes` and puts `tri-1` back in a quarter of the
 * screen.
 */
describe("the triage plan builds its own shape, NOT the shared square", () => {
  /**
   * ONE WORKER SET, BOTH CONSOLES — kept from the version this replaces, and
   * for a reason that survived the inversion: with the defaults removed from the
   * picture, everything left is the BUILDER's decision. It used to prove the two
   * agree; it now proves they cannot be made to.
   */
  const SHARED = ["w-1", "w-2", "w-3", "w-4"] as const;

  it("does NOT produce the review console's panes, on the very set that used to match", () => {
    expect(triagePanes({ ...BASE, workers: SHARED })).not.toEqual(
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
    // …and the square's table, read at RUNTIME, is a different one. If someone
    // re-delegates this plan to `agentSquarePanes`, the literal above and this
    // line stop disagreeing and both reds point at the same edit.
    expect(shape(triagePanes({ ...BASE, workers: SHARED }))).not.toEqual(
      shape(reviewPanes({ ...BASE, workers: SHARED })),
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
    // The other half of the asymmetry. `agentSquarePanes` takes the label as an
    // argument, so a swapped constant shows up here and nowhere in the layout.
    expect(() => triagePanes({ ...BASE, workers: [] })).toThrow(/^triage:/);
    expect(() => triagePanes({ ...BASE, workers: [] })).not.toThrow(/^review:/);
  });
});

/**
 * THE SEATS, READ OUT OF THE TRACKED CONFIG — hermetic, and ungated.
 *
 * `review-plan.test.ts` gates its equivalent block on `existsSync(fleet.yaml)`,
 * because none of `col-1`, `rev-arch-1`, `rev-ctx-1` or `rev-lang-1` is declared
 * in the tracked example and `fleet.yaml` is gitignored. **This console has the
 * opposite problem and therefore no gate at all**: both triage seats ARE in
 * `fleet.example.yaml`, so the pane plan can be checked against the config on
 * every clean checkout and in CI, with no skip and no machine dependency.
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
     * demoted to `observer`, which is the more likely edit and the more
     * confusing outcome — the reconciler seat would still be found, still be
     * pane 1, and would be briefed a reconciliation it has no prompt for.
     */
    expect([...DEFAULT_TRIAGE_WORKERS].map((id) => [id, roles.get(id)])).toEqual([
      ["tri-1", "triage"],
      ["obs-t1", "observer"],
      ["obs-t2", "observer"],
      ["obs-t3", "observer"],
    ]);
  });
});
