/**
 * The `review` console's plan — a collator and three reviewers, four keyboards.
 *
 * ## What this file is for that `development-plan.test.ts` is not
 *
 * The two consoles now share their pane builder outright (`agentSquarePanes`),
 * so the 2x2 split table is checked once, there, and re-asserting it here would
 * be a second copy of an assertion rather than a second assertion. What is THIS
 * console's alone is everything the shared builder cannot see:
 *
 *  - **The collator is pane 1.** Pane 1 consumes the workspace's initial
 *    surface and is where the operator lands. This console is driven by talking
 *    to the collator, so a reviewer in that seat is a console you have to click
 *    out of before you can use it — and every pane count, title set and split
 *    assertion still passes.
 *  - **Three DIFFERENT vendors.** The console's entire product is that a
 *    finding two of them reach independently is evidence. Three seats on one
 *    model is one reviewer with three transcripts, and nothing about the LAYOUT
 *    would look any different, which is exactly why it is asserted here against
 *    the config rather than left to review.
 *  - **A third distinct workspace name.** Adoption is an exact title match, so
 *    three consoles that shared a name would each adopt the others.
 *
 * The model assertions read `fleet.yaml` through `resolveWorker` rather than
 * restating the strings, because a test that restates the config passes on a
 * config that was edited to something wrong.
 */

import { describe, expect, it } from "bun:test";

import {
  DEFAULT_REVIEW_WORKERS,
  REVIEW_TOP_FRACTION,
  REVIEW_WORKSPACE,
  DEVELOPMENT_WORKSPACE,
  OPERATIONS_WORKSPACE,
  reviewPanes,
} from "../../src/backends/cmux/operations-plan.ts";
import { loadConfig, resolveWorker } from "../../src/config/load.ts";

/** The operator's own config, loaded once — `describe` bodies are not async. */
const LOADED = await loadConfig(new URL("../../fleet.yaml", import.meta.url).pathname);

const REPO = "/repo";
const BASE = { repoRoot: REPO, watchDir: "/work" } as const;

/** The default console: every worker attended, as `fleet.yaml` declares them. */
function fourAttended() {
  return reviewPanes({ ...BASE, tuiWorkers: DEFAULT_REVIEW_WORKERS });
}

describe("the review console is a 2x2 with the collator in the landing seat", () => {
  it("is a distinct workspace from both other consoles", () => {
    expect(REVIEW_WORKSPACE).toBe("review");
    expect(REVIEW_WORKSPACE).not.toBe(DEVELOPMENT_WORKSPACE);
    expect(REVIEW_WORKSPACE).not.toBe(OPERATIONS_WORKSPACE);
  });

  /**
   * THE PLACEMENT, and the assertion this file exists for.
   *
   * `split: null` is the pane that takes the workspace's initial surface, and
   * `createWorkspace` focuses it. Asserting the collator is FIRST and that
   * first is the unsplit one pins both halves of "the operator lands on the
   * collator" — index alone would survive a builder that focused elsewhere.
   */
  it("puts the collator in pane 1, the seat the keyboard lands in", () => {
    const panes = fourAttended();
    expect(panes[0]!.title).toBe("col-1");
    expect(panes[0]!.split).toBeNull();
  });

  it("names one collator and three reviewers, in pane order", () => {
    expect([...DEFAULT_REVIEW_WORKERS]).toEqual(["col-1", "rev-arch-1", "rev-ctx-1", "rev-lang-1"]);
  });

  it("titles panes by WORKER ID, because three of them share a role", () => {
    // A role title would print `reviewer` on three of the four panes. The id is
    // also what `dispatch --worker` takes, so the title is the argument.
    expect(fourAttended().map((p) => p.title)).toEqual([
      "col-1",
      "rev-arch-1",
      "rev-ctx-1",
      "rev-lang-1",
    ]);
  });

  it("leaves the halves alone — four equally sized panes is the requirement", () => {
    expect(REVIEW_TOP_FRACTION).toBeNull();
  });

  it("gives every pane a keyboard", () => {
    // Four attended panes is four runs, and `--attach-here` is the flag that
    // makes one. A pane missing it is a rendered log tail that looks alive.
    for (const p of fourAttended()) expect(p.command).toContain("'--attach-here'");
  });

  it("refuses a fifth pane, naming ITS OWN console in the refusal", () => {
    // The builder is shared, so the label is the only thing that tells an
    // operator which `--workers` flag to go and fix.
    expect(() =>
      reviewPanes({ ...BASE, workers: ["col-1", "rev-arch-1", "rev-ctx-1", "rev-lang-1", "x-1"] }),
    ).toThrow(/^review: refusing 5 workers/);
  });

  it("refuses an empty worker set", () => {
    expect(() => reviewPanes({ ...BASE, workers: [] })).toThrow(/^review: .*at least one worker/);
  });
});

/**
 * The seats, read out of the operator's own `fleet.yaml`.
 *
 * These are the assertions that would otherwise only be checked by a person
 * looking at a console and noticing nothing was wrong — which is the failure
 * mode the whole console exists to defend against, applied to itself.
 */
describe("the three reviewers run three different vendors", () => {
  const loaded = LOADED;
  const reviewers = ["rev-arch-1", "rev-ctx-1", "rev-lang-1"] as const;
  const modelOf = (id: string) => resolveWorker(loaded, id).model;

  it("gives each reviewer a DIFFERENT model", () => {
    /*
     * The console's whole product. Three seats on one model is one reviewer
     * with three transcripts: a shared training blind spot becomes invisible by
     * construction, and independent agreement — the strongest signal the
     * collator can report — stops being independent. Nothing about the LAYOUT
     * changes when this breaks, which is why it is pinned here.
     */
    const models = reviewers.map(modelOf);
    expect(new Set(models).size).toBe(reviewers.length);
  });

  it("keeps every reviewer on a hosted thinking model at full effort", () => {
    for (const id of reviewers) {
      const w = resolveWorker(loaded, id);
      expect(w.thinking, `${id} must think hard — it is a reviewer`).toBe("high");
    }
  });

  it("gives each reviewer its OWN angle on top of the shared discipline", () => {
    /*
     * Briefing fragments concatenate across levels — defaults, then role, then
     * worker — so the role's `roles/reviewer.md` and the worker's aspect file
     * must BOTH survive the merge. A `pick`-style override would silently drop
     * the shared discipline and leave three reviewers with only an angle, which
     * reads as working.
     */
    const angles = new Set<string>();
    for (const id of reviewers) {
      const files = resolveWorker(loaded, id)
        .briefing.filter((b) => b.kind === "file")
        .map((b) => b.value);
      expect(files.some((f) => f.endsWith("roles/reviewer.md")), `${id} lost the shared discipline`).toBe(true);
      const angle = files.find((f) => f.includes("/roles/review/"));
      expect(angle, `${id} has no aspect fragment`).toBeDefined();
      angles.add(angle!);
    }
    // Three reviewers, three DIFFERENT angles — not the same file three times.
    expect(angles.size).toBe(reviewers.length);
  });

  it("gives the collator write but never bash", () => {
    /*
     * One tool more than a reviewer and one short of dispatch. The write is for
     * `/outbox` — the fan-out plan and the collated report. Bash is what a
     * worker would need to reach a sibling's control socket, and §12.1's
     * argument for withholding it from a reviewer applies unchanged to the
     * worker that briefs them.
     */
    const col = resolveWorker(loaded, "col-1");
    expect(col.tools).toContain("write");
    expect(col.tools).not.toContain("bash");
    for (const id of reviewers) {
      expect(resolveWorker(loaded, id).tools, `${id} must stay read-only`).not.toContain("bash");
      expect(resolveWorker(loaded, id).tools, `${id} must stay read-only`).not.toContain("write");
    }
  });

  it("puts every review seat on a keyboard", () => {
    for (const id of DEFAULT_REVIEW_WORKERS) {
      expect(resolveWorker(loaded, id).paneMode, `${id} must be attended`).toBe("tui");
    }
  });
});
