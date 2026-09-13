/**
 * Task 8.6 — the "an envelope you never wrote/submitted does not fail your
 * task; it removes you from the grading" paraphrase is TRUE only for a role
 * that can actually fail to write an envelope: one holding a write-capable
 * verb (`bash`, `write` or `edit`). A role granted only
 * `read, grep, find, ls, submit_report` never fails to write one — the tool
 * writes it — so the sentence would be false there. Tasks 8.1/8.2/8.3 already
 * removed it from `reviewer`, `collator` and `triage` on exactly that
 * reasoning. Nothing graded the partition, so this file makes it CHECKABLE:
 * a future grant narrowing (a role losing `bash`/`write`/`edit` without its
 * prose being re-audited) reddens here instead of silently reintroducing the
 * false sentence.
 *
 * ## Which config this resolves against, and why — CORRECTING the brief
 *
 * The task that opened this file asserted `observer`, `sre`, `verifier` and
 * `collator` have no block in `fleet.example.yaml`. Verified directly by
 * parsing both files with `loadConfig` and diffing `Object.keys(config.roles)`:
 * that is true of `collator` alone. `observer`, `sre` and `verifier` all have
 * full blocks in the example and resolve identical grants from both files.
 *
 * That correction does not change which file this probe should read, but the
 * REASON has changed and the old one is recorded because it was load-bearing.
 * It read: `fleet.yaml` is gitignored and CI never creates it (`ci.yml`'s
 * unit-test step is a plain checkout + `bun test test/unit`, no step that writes
 * it), so a probe resolving against it unconditionally would be red on every
 * clean checkout. **The `ci.yml` description is still accurate; the conclusion
 * stopped following on 2026-09-12, when `fleet.yaml` became TRACKED and the
 * checkout began supplying it.** The `.gitignore:9` citation is dropped rather
 * than repointed — that entry no longer exists, and line 9 is now `coverage/`.
 *
 * What survives is a better reason: this arm grades the SHIPPED reference, so it
 * measures what the project publishes rather than what one machine runs. `test/support/role-docs.ts`'s `exampleConfig()` states the
 * identical reasoning for the identical reason, and `review-plan.test.ts`
 * documents the failure mode this caused there: a TOP-LEVEL `await
 * loadConfig("fleet.yaml")` took its whole file down (`0 pass, 1 error`) on a
 * clean checkout.
 *
 * So the invariant below resolves every role against `fleet.example.yaml`,
 * matching `worker-docs-currency.test.ts`'s "the result-writing instructions
 * are routed on the worker's tool grant" block, which does the identical
 * `roleGrant`/`writeCapableIn` resolution for the same file and the
 * same reason. `collator` is the one role this cannot check by resolution — it
 * is checked directly for the prose half of the invariant only (see below) —
 * and a second block re-runs the same check against the operator's own
 * `fleet.yaml` for full nine-role coverage including `collator`.
 *
 * **That block was `skipIf`-gated on the file "happening to be present", which
 * it no longer does — `fleet.yaml` is TRACKED as of 2026-09-12, so it is present
 * in every checkout and in CI.** The gate has been retired by inversion (the
 * check asserts the file's presence instead of skipping on its absence), which
 * matters here more than anywhere else in the suite: this is the only place
 * `collator`'s real grant is graded, and ISC-1161 called that "local-only
 * evidence that skips in CI". It is neither any more.
 *
 * ## The anchor phrase, and what it would miss
 *
 * The four carrying role files word the sentence differently enough that no
 * exact substring spans all of it: the verb varies (`observer.md` reads
 * "an envelope you never **submitted**" as of commit 8d58068 — Phase 8.4
 * routed its report through `submit_report` and the prose was updated to
 * match; `ticketing.md`, `tester.md` and `verifier.md` still read "you never
 * **wrote**"), the punctuation before "it removes" varies (`;` vs `,`), and
 * the clause after "the grading" differs every time. `ticketing.md:135-136`
 * additionally wraps the sentence across a line break before "your task",
 * and is the ONLY one that does today. `observer.md` did too until `c887c7a`
 * rewrapped that paragraph — which is exactly the point: the seam is not a
 * property of the sentence, it moves whenever someone re-wraps a file.
 * The one substring immune to all of that — verb-independent,
 * and sitting on one line in all four files today — is `removes you from the
 * grading`, so that is the anchor.
 *
 * Matched against WHITESPACE-NORMALISED, LOWER-CASED text rather than the raw
 * file, even though no current file wraps the anchor itself: `verifier.md:16`
 * opens the sentence mid-clause in lower case ("last: an envelope you never
 * wrote…"), and a future hard-wrap could still split "removes you" from "from
 * the grading" the way today's wrap already splits "does not fail" from "your
 * task" in one of these four files. `test/unit/observer-role.test.ts` collapses
 * whitespace into a `FLAT` constant for the identical reason; this does the
 * same so the two probes read the document the same way.
 *
 * WHAT IT WOULD STILL MISS: any rewording that drops "removes ... from the
 * grading" as a unit — "excludes you from grading" (no "the"), "takes you out
 * of the grading", passive voice ("you are removed from the grading"), or a
 * restatement that avoids "grading" entirely ("your findings go unscored").
 * A future author changing the wording without changing the underlying claim
 * would silently stop being checked here.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";

import { loadConfig } from "../../src/config/load.ts";
import { OBSERVER_K8S_ROLE, writeCapableIn, type FleetConfig, type ToolName } from "../../src/config/schema.ts";
import { ROOT, roleGrant } from "../support/role-docs.ts";

/** See the file header for why this substring and not the full sentence. */
const ANCHOR = "removes you from the grading";

/** Collapses whitespace (including newlines) to single spaces and lower-cases. */
function normalize(text: string): string {
  return text.replace(/\s+/g, " ").toLowerCase();
}

function carriesParaphrase(prose: string): boolean {
  return normalize(prose).includes(ANCHOR);
}

function canWriteEnvelope(tools: readonly ToolName[]): boolean {
  return writeCapableIn(tools).length > 0;
}

/**
 * The one-directional invariant itself: a role file that carries the
 * paraphrase must be paired with a write-capable grant. A role that does not
 * carry it is unconstrained here — `sre` and `engineer` hold write-capable
 * verbs and carry no paraphrase, which is PERMITTED, not required (SRD note
 * in the task brief: "permitted, not required").
 */
function pairingIsConsistent(prose: string, tools: readonly ToolName[]): boolean {
  return !carriesParaphrase(prose) || canWriteEnvelope(tools);
}

interface Evaluation {
  /** Role names where the paraphrase is carried with no write-capable verb. */
  violations: string[];
  /** Role names whose doc carries the paraphrase. */
  carriers: string[];
  /** Role names whose resolved grant holds no write-capable verb. */
  writeless: string[];
}

/**
 * Resolves every role in `cfg` (`defaults ← role`, then `exclude_tools`
 * subtracted — `roleGrant`'s resolution, the same one ISC-59's own guard
 * uses; an omitted `tools:` reads as Pi's builtins, never as nothing, and a
 * role narrowed via `exclude_tools` is not missed) and grades the invariant
 * against its `roles/<name>.md`.
 *
 * Throws rather than skipping when a role's doc file is missing: a role this
 * function cannot check is not a passing role, and a probe that skipped it
 * would report a narrowing it no longer covers.
 */
function evaluateRoles(cfg: FleetConfig): Evaluation {
  const violations: string[] = [];
  const carriers: string[] = [];
  const writeless: string[] = [];
  for (const name of Object.keys(cfg.roles)) {
    const docPath = `${ROOT}roles/${name}.md`;
    if (!existsSync(docPath)) {
      throw new Error(`role "${name}" has no roles/${name}.md — the probe has rotted`);
    }
    const prose = readFileSync(docPath, "utf8");
    const tools = roleGrant(cfg, name);
    if (carriesParaphrase(prose)) carriers.push(name);
    if (!canWriteEnvelope(tools)) writeless.push(name);
    if (!pairingIsConsistent(prose, tools)) violations.push(name);
  }
  return { violations, carriers, writeless };
}

describe("task 8.6 — the envelope-removes-you-from-grading paraphrase implies a write-capable grant", () => {
  test("every role resolvable from fleet.example.yaml satisfies the invariant", async () => {
    const { config } = await loadConfig(`${ROOT}fleet.example.yaml`);
    const { violations, carriers, writeless } = evaluateRoles(config);

    // CONTROLS: without at least one of each, the assertion below proves
    // nothing and a green probe would be reporting a partition it no longer
    // checks — the same "this probe is vacuous" shape
    // `worker-docs-currency.test.ts` guards with.
    expect(carriers, "no role's doc carries the paraphrase — this probe is vacuous").not.toEqual([]);
    expect(writeless, "no role resolved here holds zero write-capable verbs — this probe is vacuous").not.toEqual(
      [],
    );

    expect(
      violations,
      `role(s) carry the paraphrase with no write-capable verb: ${violations.join(", ")}`,
    ).toEqual([]);
  });

  /**
   * `collator` has no block in `fleet.example.yaml` (see file header), so its
   * grant is never resolved by the test above and it never enters `carriers`
   * or `writeless` there. This checks the half that IS checkable without a
   * config: its prose does not carry the paraphrase, which is the half of the
   * invariant that is true no matter what `collator`'s grant turns out to be
   * (the implication `carries -> write-capable` holds vacuously when
   * `carries` is false). What this does NOT prove: that a future edit
   * granting `collator` a write-capable verb, or narrowing it further, is
   * paired correctly — that direction needs the grant, which needs a
   * resolvable config (see the gated block below for the one that exists).
   */
  test("collator (unresolvable from the example) carries no paraphrase either", () => {
    const prose = readFileSync(`${ROOT}roles/collator.md`, "utf8");
    expect(carriesParaphrase(prose)).toBe(false);
  });
});

/**
 * The operator's own `fleet.yaml`, read UNCONDITIONALLY as of 2026-09-12.
 *
 * It followed `review-plan.test.ts`'s pattern exactly — `existsSync` gating a
 * `describe.skipIf`, with `loadConfig` inside a `test` rather than at module
 * scope — and that pattern was right while the file was gitignored and absent
 * from CI. The file is TRACKED now, so the gate's condition is always true: it
 * skipped nowhere while still reading as conditional, which is a test that has
 * stopped being able to tell you anything about its own coverage.
 *
 * **This block is the one that mattered most**, which is why the gate is retired
 * rather than left as harmless decoration. `collator` has no block in
 * `fleet.example.yaml`, so this is the only place its actual grant is checked
 * against its prose — ISC-1161 graded that coverage "local-only evidence that
 * skips in CI". It is neither of those things any more, and a gate claiming
 * otherwise would keep that grade looking honest.
 *
 * `loadConfig` stays inside the `test` for the reason that never depended on the
 * ignore: a throw at module scope takes the whole file down, including the four
 * assertions that need no config.
 */
const LIVE_CONFIG_PATH = `${ROOT}fleet.yaml`;
const HAVE_LIVE_CONFIG = existsSync(LIVE_CONFIG_PATH);

describe(
  "task 8.6, against the operator's own fleet.yaml (nine roles, collator included)",
  () => {
    test("every role in the live config satisfies the invariant, collator included", async () => {
      expect(
        HAVE_LIVE_CONFIG,
        `${LIVE_CONFIG_PATH} is missing — fleet.yaml is tracked, so this is a broken checkout`,
      ).toBe(true);
      const { config } = await loadConfig(LIVE_CONFIG_PATH);
      expect(
        Object.keys(config.roles),
        "fleet.yaml no longer declares a collator role — this block's extra coverage is gone",
      ).toContain("collator");

      const { violations, carriers, writeless } = evaluateRoles(config);
      expect(carriers, "no role's doc carries the paraphrase — this probe is vacuous").not.toEqual([]);
      expect(writeless, "no role resolved here holds zero write-capable verbs — this probe is vacuous").not.toEqual(
        [],
      );
      expect(writeless, "collator is expected to hold no write-capable verb").toContain("collator");
      expect(
        violations,
        `role(s) carry the paraphrase with no write-capable verb: ${violations.join(", ")}`,
      ).toEqual([]);
    });
  },
);

describe("the checker is reddenable, driven through resolution rather than through editing roles/*.md", () => {
  /**
   * Neither `roles/observer.md` nor `roles/reviewer.md` is owned by this
   * round, and neither is touched here — both are read exactly as committed.
   * The mutation is entirely in which GRANT is paired with which document:
   * `reviewer`'s real, resolved, write-less grant stands in for a future
   * narrowing that reassigns paraphrase-carrying prose to a trimmed role
   * without the prose being re-audited — precisely the scenario task 8.6
   * exists to catch.
   */
  test("pairing a write-less role's real grant with paraphrase-carrying prose is caught", async () => {
    const { config } = await loadConfig(`${ROOT}fleet.example.yaml`);

    const reviewerTools = roleGrant(config, "reviewer");
    expect(canWriteEnvelope(reviewerTools), "reviewer is expected to hold no write-capable verb").toBe(false);

    const observerProse = readFileSync(`${ROOT}roles/${OBSERVER_K8S_ROLE}.md`, "utf8");
    expect(carriesParaphrase(observerProse), "observer.md is expected to carry the paraphrase").toBe(true);

    // THE RED CASE: reviewer's real grant, observer's real prose.
    expect(pairingIsConsistent(observerProse, reviewerTools)).toBe(false);
  });

  test("the same prose paired back with its own role's real grant passes", async () => {
    const { config } = await loadConfig(`${ROOT}fleet.example.yaml`);
    const observerTools = roleGrant(config, OBSERVER_K8S_ROLE);
    const observerProse = readFileSync(`${ROOT}roles/${OBSERVER_K8S_ROLE}.md`, "utf8");

    // THE GREEN CASE: the pairing corrected back to the real grant.
    expect(pairingIsConsistent(observerProse, observerTools)).toBe(true);
  });
});
