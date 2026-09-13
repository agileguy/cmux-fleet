/**
 * `roles/observer-k8s.md` says only things that are true about how it
 * reports — task 8.4 of Phase C prose.
 *
 * ## Why this role's rewrite is not a copy of 8.1/8.2/8.3's
 *
 * `fleet.example.yaml`'s `observer-k8s` is
 * `tools: [read, write, bash, grep, find, ls, submit_report]` — the only role
 * Phase 8 has touched so far that holds a
 * write-capable builtin AND `submit_report` at once. Reviewer and triage hold
 * `submit_report` with no write verb at all, so their prose could say "you
 * have no write tool, call it" and be unconditionally true; that argument does
 * not apply here, because observer's `write` is real and does report-related
 * work of its own: it is how the `observer-ops.json`/`.md` pair reaches the
 * outbox (`skills/observer-ops/SKILL.md`, `roles/observer-k8s.md`).
 * `submit_report` is still the only route for the envelope itself.
 *
 * `skills/pifleet-worker/SKILL.md`'s routing table settles the "both" case
 * explicitly: *"Call `submit_report`. The hand-written envelope stays
 * physically possible and is not yours to write."* The sentence task 8.4
 * replaced ordered exactly that hand-written envelope — `result.json`
 * "written last" — which is the wrong route for this grant, not a stale
 * mechanic every role outgrew the same way.
 *
 * 8.4 went one step further and also moved the `observer-ops` PAIR onto that
 * same `report` argument. That part was wrong: the pair is un-cleared for
 * Phase 7 (SRD-WORKER-DISPATCH-EXTENSION.md §11 — this model truncates
 * silently above 4KB, and harvested pairs on this fleet run up to 17.8KB), so
 * it stays on `write`, declared afterward in `artifacts[]`. This file's tests
 * below pin that correction, not 8.4's original routing.
 *
 * ## What is checkable here
 *
 * The grant, read from the shipped config through the same functions the host
 * resolves it with; and the prose, checked for the false order's absence, the
 * grant-routed instruction's presence, and the still-true grading consequence
 * task 8.6 depends on finding here. Everything above line 144 — the pacing
 * budget, the `write`-is-for-your-outbox argument, the artifact-pair rule — is
 * untouched by this task and is not re-graded by this file.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

import { loadConfig } from "../../src/config/load.ts";
import { OBSERVER_K8S_ROLE, writeCapableIn } from "../../src/config/schema.ts";
import { roleGrant } from "../support/role-docs.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const ROLE = readFileSync(`${ROOT}roles/${OBSERVER_K8S_ROLE}.md`, "utf8");

/**
 * Wrapped prose, flattened the way `role-docs.ts` and `triage-role.test.ts`
 * both flatten it: every sentence in this document is longer than its wrap
 * column, so a raw `toContain` over a slice is really an assertion about
 * where a line happens to break, not about what the sentence says.
 */
const FLAT = ROLE.replace(/\s+/g, " ");

describe("observer's resolved grant is the one this file's routing argument assumes", () => {
  /**
   * CONTROL, not incidental. Everything below rests on observer holding BOTH
   * `submit_report` and a write-capable tool at once — the one grant shape
   * where "call submit_report, the hand-written route is not yours" is the
   * correct instruction rather than a redundant one. If a future edit narrows
   * observer to `submit_report`-only (the reviewer/triage shape) or drops
   * `submit_report` back to a bare write role, this task's paragraph stops
   * being the right instruction — and this control is what turns that into a
   * failure here instead of two vacuously-passing tests below.
   */
  test("CONTROL: observer holds submit_report alongside a write-capable tool", async () => {
    const { config } = await loadConfig(`${ROOT}fleet.example.yaml`);
    // `roleGrant` resolves `defaults ← role`, then subtracts `exclude_tools`
    // (`render.ts`'s real `--exclude-tools` subtraction), and throws loudly if
    // `fleet.example.yaml` no longer declares an observer role at all — this
    // probe cannot check a role that is gone.
    const tools = roleGrant(config, OBSERVER_K8S_ROLE);
    expect(tools).toContain("submit_report");
    expect(
      tools,
      "observer no longer holds `write` alongside submit_report — narrowing task 7.5 removes " +
        "`write` but keeps `bash` (also write-capable per WRITE_CAPABLE_TOOLS), so the " +
        "writeCapableIn() check below alone would stay green through exactly that narrowing " +
        "while the prose \"You hold `submit_report` alongside `write`\" goes false",
    ).toContain("write");
    expect(
      writeCapableIn(tools).length,
      "observer no longer holds a write-capable tool alongside submit_report — the 'both' " +
        "routing case this file's prose argues from no longer applies to it",
    ).toBeGreaterThan(0);
  });
});

describe("the file does not order a hand-written result.json (task 8.4)", () => {
  /**
   * The false order, pinned to the PHRASE it was made of rather than to the
   * line numbers it sat on — a later task narrowing or rewording this
   * paragraph must not silently reopen the instruction this one removed.
   */
  test("the false order is gone: nothing tells a submit_report holder to write result.json last", () => {
    expect(FLAT).not.toContain("result.json` written last");
    expect(FLAT).not.toContain("written separately from the `observer-ops` files above");
  });

  /**
   * The replacement routes on the GRANT, per the task: it names the tool to
   * call and says plainly that the hand-composed route is not observer's,
   * rather than re-ordering a hand-written envelope in different words.
   */
  test("the file routes the envelope on the grant: call submit_report, the hand-written route is not yours", () => {
    expect(FLAT).toContain("call `submit_report` for your envelope");
    expect(FLAT).toContain("yours to leave alone, not yours to take");
  });

  /**
   * The mechanism this fix corrects: the observer-ops pair is un-cleared for
   * Phase 7 (SRD §11 — the model truncates silently above 4KB, and harvested
   * pairs on this fleet run up to 17.8KB) and so must NOT ride `report`. It
   * still reaches the outbox through `write`, exactly as the `observer-ops`
   * skill describes, and is then declared in `artifacts[]` — the slot
   * `pifleet-worker` reserves for files the worker wrote itself.
   */
  test("the observer-ops pair is handed over through `write`, not through `report`", () => {
    // A longer contiguous anchor, not two independent substrings: the phrase
    // "exactly as the `observer-ops` skill describes" also appears, unrelated,
    // in the artifact-pair paragraph above line 144 (about the .json/.md pair
    // itself) — pinning it alone would pass even if this paragraph's routing
    // said something else entirely.
    expect(FLAT).toContain(
      "The `observer-ops.json`/`.md` pair still goes through `write`, into " +
        "`/outbox/<task-id>/files/`, exactly as the `observer-ops` skill describes",
    );
  });

  test("the pair is declared in artifacts[] as files the observer wrote itself", () => {
    expect(FLAT).toContain(
      "then name both files in `artifacts[]`, the slot `pifleet-worker` reserves for files you wrote yourself",
    );
  });
});

describe("the grading consequence survives in substance (task 8.6 depends on it)", () => {
  /**
   * ISC/task 8.6 reads this file expecting "an envelope you never wrote/
   * submitted does not fail your task; it removes you from the grading" to
   * still be here. Asserted by the surviving clauses rather than by the exact
   * old sentence, since 8.4's rewrite changed "wrote" to "submitted" for
   * accuracy (the act is now a call, not a write) without changing what it
   * means for the observer.
   */
  test("an unsubmitted envelope removes the observer from grading rather than failing the task", () => {
    expect(FLAT).toContain("does not fail your task");
    expect(FLAT).toContain("it removes you from the grading");
    expect(FLAT).toContain("reports your findings as unchecked");
    expect(FLAT).toContain("speaks for nothing in your absence");
  });
});
