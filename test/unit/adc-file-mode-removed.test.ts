/**
 * ISC-268 — `adc_mode: file` is REFUSED, and nothing is left over from it.
 *
 * ## Which arm this is, and why
 *
 * The criterion offered two ways to close: wire `file` mode so it actually
 * mounts an ADC file, or remove it from the schema along with its three
 * symbols and the mount guard's carve-out. Leaving it accepted-and-inert
 * satisfied neither, and inert is what it was — an operator could set it, `up`
 * would not refuse, and no credential was mounted. That failure surfaces as an
 * unexplained permission error inside the container rather than at launch.
 *
 * Removal was chosen on what wiring would have MOUNTED. The host ADC file is
 * `type: authorized_user` and carries a `refresh_token`: a non-expiring grant
 * over the operator's entire Google account, which SRD §12.4 lists as F37 and
 * bounds elsewhere by preferring a ~1 h access token. Wiring it would have
 * made the most dangerous credential path the FIRST one built — ISC-248
 * established there is no credential runtime at all yet — into a container
 * running model output, on a machine where the end-to-end result cannot be
 * verified. A mode nobody had asked for is not worth that.
 *
 * ## What this file pins, beyond the refusal itself
 *
 * A removal is only complete if the things that referenced it went too. The
 * one that matters is `classifyHostGcloudExposure`'s carve-out: it permitted
 * exactly one artifact out of the host gcloud store to be mounted, it was the
 * most delicate branch in that guard, and it defended a path nothing took. An
 * exception with no caller is not a dormant feature — it is an untested hole
 * with a comment over it, and it would have become load-bearing on its first
 * real run.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { stringify } from "yaml";
import { parseConfig } from "../../src/config/load.ts";
import { AdcModeSchema } from "../../src/contracts.ts";
import { classifyHostGcloudExposure, hostAdcFile, hostGcloudConfigDir } from "../../src/security/adc.ts";
import { stripComments } from "../support/source-structure.ts";

const ROOT = new URL("../../", import.meta.url).pathname;

function doc(adcMode: string): string {
  return stringify({
    version: 2,
    name: "adc-fleet",
    docker: { pi_version: "0.79.6" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: { model: "TestModel" },
    cloud: { adc: true, adc_mode: adcMode },
    roles: { eng: { cloud_access: true } },
    workers: [{ id: "w1", role: "eng" }],
  });
}

describe("ISC-268: adc_mode: file is refused, not accepted and ignored", () => {
  test("the config schema rejects it", async () => {
    await expect(parseConfig(doc("file"), "/tmp/fleet.yaml")).rejects.toThrow();
  });

  /**
   * The refusal has to NAME the field. The field was kept as a one-value enum
   * rather than deleted precisely so this message says "adc_mode … expected
   * 'token'"; deleting it would have produced `.strict()`'s "unrecognized key",
   * which tells an operator their config has a typo rather than that a mode
   * they were relying on is gone.
   */
  test("and the refusal names the field, not a generic unknown-key error", async () => {
    let message = "";
    try {
      await parseConfig(doc("file"), "/tmp/fleet.yaml");
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toContain("adc_mode");
    expect(message).not.toContain("Unrecognized key");
  });

  test("token is still accepted, so the refusal is about the value", async () => {
    const loaded = await parseConfig(doc("token"), "/tmp/fleet.yaml");
    expect(loaded.config.cloud.adc_mode).toBe("token");
  });

  /**
   * The injected-record type too. A two-valued type whose second value nothing
   * can produce is the same "accepted and inert" shape one layer down, and a
   * probe asserting "which mode was actually used" would be asserting against
   * a set that lies about what is reachable.
   */
  test("the injection record cannot claim a mode the config cannot express", () => {
    expect(AdcModeSchema.options).toEqual(["token"]);
    expect(AdcModeSchema.safeParse("file").success).toBe(false);
  });
});

describe("ISC-268: the host gcloud store guard has no exception left", () => {
  /**
   * Positive control first. If `hostAdcFile()` were not under the store, the
   * assertion below would pass for the wrong reason and this whole guard would
   * be vacuous.
   */
  test("the ADC file really is inside the store, so the next test means something", () => {
    expect(hostAdcFile().startsWith(hostGcloudConfigDir())).toBe(true);
  });

  test("the one file the carve-out used to permit is now refused like any other", () => {
    expect(classifyHostGcloudExposure(hostAdcFile())).toBe("inside-the-store");
    expect(classifyHostGcloudExposure(hostGcloudConfigDir())).toBe("is-the-store");
  });

  /**
   * And the opt-out is gone from the SOURCE, not merely unused. A surviving
   * optional parameter defaulting to `false` would pass every assertion above
   * while leaving the hole one argument away — which is how it existed in the
   * first place.
   */
  test("no opt-out parameter survives anywhere in the credential module", () => {
    const adc = stripComments(readFileSync(`${ROOT}src/security/adc.ts`, "utf8"));
    expect(adc).not.toContain("allowAdcFile");
    expect(adc).not.toContain("ADC_FILE_PATH");
    expect(adc).not.toContain("fileModeMaterials");
    expect(adc).not.toContain("fileModeStartupEnv");
  });
});
