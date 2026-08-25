/**
 * The credential plan REPORTS the configured mode; it does not emit a literal.
 *
 * ## Why this file exists at all
 *
 * It replaces discrimination that ISC-268 destroyed. `test/integration/
 * up-wiring.test.ts` used to run two fixtures — one taking `adc_mode` from the
 * schema default, one setting `adc_mode: file` explicitly — and the CONTRAST
 * between them is what proved `up`'s per-worker grant line prints the mode it
 * resolved rather than a constant that happens to read `token`. With `file`
 * removed there is one mode, and no fixture can tell those two apart any more:
 * a `planCredential` whose body said `mode: "token"` would satisfy every
 * behavioural test in the repository.
 *
 * Deleting the contrast and saying nothing would have quietly downgraded
 * ISC-251's evidence — the criterion asserts `up` STATES the grant per worker,
 * and "states it" is only meaningful if the statement tracks the input.
 *
 * ## Why structural, and what it can and cannot show
 *
 * This is a fact about the source: the mode on the plan is `role.adcMode`. It
 * cannot prove the value reaches the printed line — `describeCredentialPlan`
 * and its callers do that, and they are covered behaviourally. It proves the
 * one link the fixtures can no longer exercise, which is the link that went
 * dark.
 *
 * When a second mode returns, put the two-fixture contrast back and delete
 * this. A live fixture is better evidence than a source check.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { AdcModeSchema } from "../../src/contracts.ts";
import { planCredential } from "../../src/security/adc.ts";
import { functionBody, stripComments } from "../support/source-structure.ts";

const ROOT = new URL("../../", import.meta.url).pathname;
const ADC = stripComments(readFileSync(`${ROOT}src/security/adc.ts`, "utf8"));

describe("ISC-251/268: the credential plan carries the configured mode through", () => {
  test("planCredential's mode is read from the role, not written as a literal", () => {
    const body = functionBody(ADC, "planCredential");
    expect(body, "planCredential moved or was renamed").not.toBeNull();
    expect(body).toContain("mode: role.adcMode");
    // The mutation this is here to catch, named: a body that hardcodes the one
    // mode there currently is would be invisible to every behavioural test.
    for (const mode of AdcModeSchema.options) {
      expect(body).not.toContain(`mode: "${mode}"`);
    }
  });

  /**
   * And behaviourally, for the one mode that exists — so this file is not a
   * pure source check. It cannot discriminate, which is the whole problem, but
   * it does pin that the plan is built and carries the field at all.
   */
  test("a cloud role's plan reports the mode it was given", () => {
    const plan = planCredential({
      cloudAccess: true,
      adcMode: "token",
      impersonateServiceAccount: null,
      quotaProject: null,
    });
    expect(plan).toEqual({
      kind: "inject",
      mode: "token",
      impersonateServiceAccount: null,
      quotaProject: null,
    });
  });

  test("a role without cloud access gets no mode at all", () => {
    // The absence is a statement the run is required to make (SRD §5.8), so it
    // must not acquire a mode it was never granted.
    const plan = planCredential({
      cloudAccess: false,
      adcMode: "token",
      impersonateServiceAccount: null,
      quotaProject: null,
    });
    expect(plan).toEqual({ kind: "none", reason: "cloud_access_false" });
    expect(plan).not.toHaveProperty("mode");
  });
});
