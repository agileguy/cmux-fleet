/**
 * Role resolution (SRD §14, Phase 5).
 *
 * Two properties here are the kind that regress silently, so they get their
 * own tests rather than riding along:
 *
 *  - The verifier is INDEPENDENT of the sre. §14.2's workflow only means
 *    anything if the confirming role does not take the remediating role's
 *    word — a verifier briefed to trust the remediation is theatre, and
 *    nothing about the code would fail if someone softened the text.
 *
 *  - Briefings are data, never authority. `cloud_allow[]` on the envelope is
 *    the only thing that decides what a worker may run; a briefing that
 *    "authorizes" anything is a permission system in prose that the verbgate
 *    and ledger never hear about.
 */

import { describe, expect, test } from "bun:test";
import {
  INVESTIGATOR_BRIEFING,
  SRE_BRIEFING,
  VERIFIER_BRIEFING,
} from "../../src/roles/briefings.ts";
import { BRIEFINGS, ROLE_NAMES, composeBrief, roleBriefing } from "../../src/roles/index.ts";
import { TaskSpecSchema } from "../../src/contracts.ts";

/** A minimal TaskSpec body; `role` is what each test varies. */
const spec = (role: unknown) => ({ id: "t1", title: "t", brief: "fix the probe", role });

describe("role resolution", () => {
  test("each named role resolves to its own non-empty briefing", () => {
    expect(roleBriefing("sre")).toBe(SRE_BRIEFING);
    expect(roleBriefing("investigator")).toBe(INVESTIGATOR_BRIEFING);
    expect(roleBriefing("verifier")).toBe(VERIFIER_BRIEFING);
    for (const name of ROLE_NAMES) {
      const text = roleBriefing(name);
      expect(typeof text).toBe("string");
      expect((text as string).length).toBeGreaterThan(100);
    }
  });

  test("null is the fleet default: no role text, brief passes through untouched", () => {
    // The schema's default IS null — a task list that never mentions role
    // must land here, not on some role picked for it.
    const parsed = TaskSpecSchema.parse({ id: "t1", title: "t", brief: "b" });
    expect(parsed.role).toBeNull();
    expect(roleBriefing(null)).toBeNull();
    expect(composeBrief(null, "exactly this brief")).toBe("exactly this brief");
  });

  test("the resolver and the contracts vocabulary accept the same set of roles", () => {
    // Probed from both sides so a role added to contracts.ts without a
    // briefing (or vice versa) fails at runtime as well as at compile time.
    const probes = ["sre", "investigator", "verifier", "engineer", "reviewer", "tester", "boss"];
    const accepted = probes.filter((r) => TaskSpecSchema.safeParse(spec(r)).success);
    expect(accepted.sort()).toEqual([...ROLE_NAMES].sort());
  });

  test("an unknown role is a loud error, not a silent role-less dispatch", () => {
    expect(() => roleBriefing("engineer" as never)).toThrow(/unknown role: engineer/);
    expect(() => composeBrief("boss" as never, "b")).toThrow(/unknown role/);
  });

  test("composition carries the briefing first and the task brief intact", () => {
    const brief = "MARKER: restart nothing, check the readiness probe";
    const composed = composeBrief("verifier", brief);
    expect(composed).toContain(VERIFIER_BRIEFING);
    expect(composed).toContain(brief);
    // The briefing is the frame the task is read inside, so it must lead.
    expect(composed.indexOf(VERIFIER_BRIEFING)).toBeLessThan(composed.indexOf(brief));
  });
});

describe("verifier independence (SRD §14.2)", () => {
  test("the verifier is briefed to distrust the remediation it checks", () => {
    // These phrases carry the independence property. If a rewrite drops the
    // claim-is-under-test framing or the re-derive instruction, the workflow
    // degrades to the sre grading itself with extra steps — and this test is
    // the only thing that goes red.
    expect(VERIFIER_BRIEFING).toMatch(/thing under test/i);
    expect(VERIFIER_BRIEFING).toMatch(/re-derive/i);
    expect(VERIFIER_BRIEFING).toMatch(/nothing you were handed is evidence/i);
    expect(VERIFIER_BRIEFING).toMatch(/the cluster wins/i);
  });

  test("no briefing tells the verifier to accept the sre's account", () => {
    expect(VERIFIER_BRIEFING).not.toMatch(/assume the remediation (worked|succeeded)/i);
    expect(VERIFIER_BRIEFING).not.toMatch(/trust the (sre|remediation|report|summary)/i);
    // And the sre is told the inverse — its claim WILL be checked — so the
    // pair of briefings describes one workflow, not two contradicting ones.
    expect(SRE_BRIEFING).toMatch(/will be checked/i);
  });

  test("verifier and sre briefings are distinct texts, not one reused blob", () => {
    expect(VERIFIER_BRIEFING).not.toBe(SRE_BRIEFING);
    expect(VERIFIER_BRIEFING.includes(SRE_BRIEFING)).toBe(false);
    expect(SRE_BRIEFING.includes(VERIFIER_BRIEFING)).toBe(false);
  });
});

describe("briefings are data, not authority (requirement 9)", () => {
  test("no briefing contains grant language or names the allowlist field", () => {
    for (const [name, text] of Object.entries(BRIEFINGS)) {
      // Naming the field invites the worker to reason about widening it;
      // grant phrasing IS an authorization, made in a place that cannot
      // enforce or audit one. Both are absent by construction and this
      // test keeps them absent.
      expect(text, `${name} names cloud_allow`).not.toMatch(/cloud_allow/);
      expect(text, `${name} grants`).not.toMatch(/you are (now )?(authorized|permitted|allowed)/i);
      expect(text, `${name} grants`).not.toMatch(/you may (now )?(run|execute|use)/i);
      expect(text, `${name} grants`).not.toMatch(/grants? you/i);
      expect(text, `${name} grants`).not.toMatch(/unrestricted/i);
      expect(text, `${name} grants`).not.toMatch(/permission (is )?granted/i);
    }
  });

  test("resolution is a data lookup: the returned text is the constant itself", () => {
    // Identity, not equality: templating or per-call mutation of a briefing
    // would be a code path deciding what a worker is told, and the first
    // thing such a path grows is a conditional.
    for (const name of ROLE_NAMES) {
      expect(roleBriefing(name)).toBe(BRIEFINGS[name]);
    }
  });
});
