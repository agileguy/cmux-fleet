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

import { beforeAll, describe, expect, it } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import {
  DEFAULT_REVIEW_WORKERS,
  REVIEW_TOP_FRACTION,
  REVIEW_WORKSPACE,
  DEVELOPMENT_WORKSPACE,
  OPERATIONS_WORKSPACE,
  reviewPanes,
} from "../../src/backends/cmux/operations-plan.ts";
import { loadConfig, resolveWorker } from "../../src/config/load.ts";

/**
 * The operator's own `fleet.yaml` — READ ONLY WHERE IT EXISTS, and the whole
 * of this block is about the fact that it usually does not.
 *
 * ## What was wrong, and why the audit could not see it
 *
 * This was a TOP-LEVEL `await loadConfig(...)`. `fleet.yaml` is gitignored
 * (`.gitignore:9`; `git ls-files --error-unmatch fleet.yaml` errors), so on any
 * clean checkout the await threw at IMPORT time and the file reported `0 pass,
 * 1 fail, 1 error` — taking all thirteen tests down, including the eight that
 * need no config at all. A machine dependency should cost the assertions that
 * depend on the machine, never the whole file.
 *
 * **This is the fourth machine dependency in `test/unit`, and it is the mirror
 * of the twenty-two `6f35f0d` removed.** That sweep enumerated three
 * capabilities and was verified inside a worker container — which bind-mounts
 * the maintainer's checkout and therefore HAS `fleet.yaml`. The environment
 * that audited hermeticity was the one environment where this dependency is
 * invisible, exactly as the operator's own machine was for the first
 * twenty-two. What would have caught it is a sweep run somewhere that has the
 * repository but not the operator's untracked config: a fresh `git worktree`,
 * a `git archive` extraction, or CI itself.
 *
 * ## Why the config is still READ rather than restated as a fixture
 *
 * The header's argument stands: "a test that restates the config passes on a
 * config that was edited to something wrong." Inlining a roster fixture would
 * turn these five into a test of `resolveWorker` and stop them being a test of
 * THIS FLEET's review console, which is the only thing they are for.
 * `fleet.example.yaml` is tracked but declares none of `col-1`, `rev-arch-1`,
 * `rev-ctx-1` or `rev-lang-1`, so it cannot stand in either.
 *
 * So they run where the fact exists and SKIP, by name, where it does not — the
 * same disposition every gated probe in this repository already has. The eight
 * layout assertions below are unaffected and now run in CI, which they did not
 * before.
 *
 * ## A COLLECTED-COUNT QUIRK, measured here because it bites constants elsewhere
 *
 * `describe.skipIf` reports ONE MORE skip than the block holds. Measured in one
 * worktree both ways: with `fleet.yaml` present this file is `13 pass, Ran 13`;
 * with it absent, `8 pass, 6 skip, Ran 14` — and the guarded block contains
 * five `it`s, not six. Bun counts the skipped `describe` itself as an entry.
 *
 * Harmless here, because the `test` job grades pass/fail rather than a total.
 * Recorded because `probe-guard.sh` grades a COLLECTED total against a pinned
 * `TOTAL_EXPECTED`, and a `describe.skipIf` added to any file in that job's
 * list would move the total by n+1 rather than n — which is precisely the kind
 * of off-by-a-little that made `TOTAL_EXPECTED` wrong by 12 and self-consistent
 * at the same time.
 */
const CONFIG_PATH = new URL("../../fleet.yaml", import.meta.url).pathname;
/** `roles/collator.md` is TRACKED, unlike `fleet.yaml` — resolved the same way regardless. */
const COLLATOR_DOC = new URL("../../roles/collator.md", import.meta.url).pathname;
const HAVE_CONFIG = existsSync(CONFIG_PATH);

/**
 * Populated by `beforeAll` inside the guarded block, never at module scope —
 * an import-time load is what took the file down, and moving it into the block
 * is what bounds the blast radius to the assertions that need it.
 */
let LOADED: Awaited<ReturnType<typeof loadConfig>> | undefined;

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
describe.skipIf(!HAVE_CONFIG)("the three reviewers run three different vendors", () => {
  beforeAll(async () => {
    LOADED = await loadConfig(CONFIG_PATH);
  });
  /*
   * A GETTER, not a captured value. `describe` bodies run before `beforeAll`,
   * so a `const loaded = LOADED` here would capture `undefined` and every
   * assertion below would fail on a machine that HAS the config — turning a
   * skip into a break, which is the opposite of the repair.
   */
  const loaded = () => {
    if (LOADED === undefined) throw new Error("fleet.yaml was not loaded — beforeAll did not run");
    return LOADED;
  };
  const reviewers = ["rev-arch-1", "rev-ctx-1", "rev-lang-1"] as const;
  const modelOf = (id: string) => resolveWorker(loaded(), id).model;

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

  it("names each reviewer's ACTUAL model in the collator's own briefing table", () => {
    /*
     * `roles/collator.md` opens with a table of the three reviewers and the
     * model each one runs, and the collator writes its briefs from it. That
     * table is a COPY of `fleet.yaml`, so it can go stale in the one direction
     * nothing else notices: the config changes, the doc keeps naming the model
     * that used to be there, and every other probe in this file still passes.
     *
     * MEASURED 2026-09-04: it had already gone stale that way. The seats moved
     * to glm-5.3 / gemma4:31b / gpt-oss:120b and the doc still said
     * deepseek-v4-pro / qwen3.5:397b / kimi-k3 — three names, all wrong, in the
     * document whose entire job is telling the collator who it is briefing.
     *
     * The check runs BOTH WAYS on purpose. Requiring only that each row's model
     * is one the console runs would pass on a doc that gives every row the same
     * model; requiring only that every configured model appears somewhere would
     * pass on a doc that swapped two rows. The pairing is the assertion.
     */
    const doc = readFileSync(COLLATOR_DOC, "utf8");
    for (const id of reviewers) {
      const row = doc.split("\n").find((l) => l.startsWith(`| \`${id}\``));
      expect(row, `roles/collator.md has no table row for ${id}`).toBeDefined();
      const named = [...row!.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).slice(1);
      expect(
        named,
        `${id}'s row names ${JSON.stringify(named)} — it runs ${modelOf(id)}`,
      ).toContain(modelOf(id));
    }
    // And no row may name a model this console does not run: a leftover name
    // beside the right one still tells the collator something false.
    const configured = new Set(reviewers.map(modelOf));
    for (const id of reviewers) {
      const row = doc.split("\n").find((l) => l.startsWith(`| \`${id}\``))!;
      for (const named of [...row.matchAll(/`([^`]+)`/g)].map((m) => m[1]!).slice(1)) {
        expect(configured.has(named), `${id}'s row names \`${named}\`, which no reviewer runs`).toBe(true);
      }
    }
  });

  it("keeps every reviewer on a hosted thinking model at full effort", () => {
    for (const id of reviewers) {
      const w = resolveWorker(loaded(), id);
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
      const files = resolveWorker(loaded(), id)
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

  it("gives every review seat write, and none of them bash or edit", () => {
    /*
     * REWRITTEN 2026-09-04, and the old assertion is recorded rather than
     * quietly relaxed. It required every reviewer to hold no `write`, which was
     * true of the config and made the console unable to function: nothing
     * host-side writes `result.json` (`harvest/outbox.ts` only reads it), so a
     * reviewer with no writer tool could not report at all — every lens missing,
     * `relay.ts` answering `not_collated`, no collation ever dispatched, and the
     * fan-out task settling `success` with the review showing green. The owner
     * granted `write`, outbox-only, on the collator's precedent.
     *
     * The line §12.1 actually draws is BASH, not writing: a shell is what turns a
     * read-only reviewer into a worker that can `cd /`, reach a socket or
     * `git push`. Write-to-outbox is how every other worker in this fleet
     * reports, into a worker-scoped mount that is already the untrusted-content
     * boundary. `edit` stays withheld because it would buy nothing — the only
     * files a reviewer sees besides its outbox are the `:ro` checkout.
     *
     * So the three members are asserted SEPARATELY. A single "the tools changed"
     * check would be satisfied by adding `bash`, which is the one thing this
     * block exists to refuse.
     */
    const col = resolveWorker(loaded(), "col-1");
    expect(col.tools).toContain("write");
    expect(col.tools).not.toContain("bash");
    for (const id of reviewers) {
      const tools = resolveWorker(loaded(), id).tools;
      expect(tools, `${id} cannot write its result envelope`).toContain("write");
      expect(tools, `${id} must never hold a shell`).not.toContain("bash");
      expect(tools, `${id} has a read-only checkout; edit buys nothing`).not.toContain("edit");
    }
  });

  it("puts every review seat on a keyboard", () => {
    for (const id of DEFAULT_REVIEW_WORKERS) {
      expect(resolveWorker(loaded(), id).paneMode, `${id} must be attended`).toBe("tui");
    }
  });
});
