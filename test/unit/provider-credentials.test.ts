/**
 * Each provider is dialed with ITS OWN credential — ISC-425 and ISC-418.
 *
 * ## The defect these were written against, measured rather than imagined
 *
 * `buildWorkerEnv` read the FLEET-WIDE `llm.api_key_env` for every worker
 * whatever provider it resolved to, and `assertModelsSupportToolCalls` read the
 * fleet-wide `llm.base_url` and `llm.api_key_env` for every model it certified.
 * On a live two-provider run whose blocks named `OLLAMA_API_KEY` and
 * `VENDOR_B_API_KEY`, both workers received a secret file called
 * `OMLX_API_KEY` — the schema default — at mode 0444 behind a read-only mount.
 *
 * Everything about the DELIVERY was correct. ISC-407 (no key in the
 * environment), ISC-408 (0444, read-only) and ISC-422 (not claimed as an
 * operator grant) were all green and all still are: each of them asks HOW the
 * key travels and none of them asks WHOSE it is. That gap is the whole reason
 * this file exists as its own suite rather than as three more cases inside
 * `worker-env.test.ts`.
 *
 * ## Why the fixture serves ONE model id from BOTH providers
 *
 * Deliberate, and it is the sharpest thing here. The gate de-duplicates before
 * probing — six workers on one model is the normal fleet shape and probing it
 * six times would cost six real generations — and it used to de-duplicate on
 * the MODEL ID alone. Two providers serving `gpt-oss` is the ordinary case, not
 * a contrived one: the operator's own oMLX and a hosted catalogue both serve it.
 * De-duped on the id, one endpoint gets certified and the other is silently
 * passed. A fixture using two different model ids cannot see that at all.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { stringify } from "yaml";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { parseConfig, providerApiKeyEnv, resolveWorker, type LoadedConfig } from "../../src/config/load.ts";
import { buildWorkerEnv } from "../../src/run/worker-env.ts";
import { assertModelsSupportToolCalls } from "../../src/security/model-probe.ts";
import type { FetchLike } from "../../src/security/model-probe.ts";

/** The one model id BOTH providers serve — see the header. */
const MODEL = "gpt-oss";

const LOCAL_URL = "http://omlx.pifleet.internal:8000/v1";
const CLOUD_URL = "https://ollama.com/v1";

/**
 * Three sentinels, and the third is the anti-vacuity one.
 *
 * `OMLX_API_KEY` is the schema DEFAULT for `llm.api_key_env`, so it is the
 * value the pre-fix code handed every worker. Giving it a distinct sentinel and
 * asserting it appears nowhere is what makes these tests fail against that
 * code rather than merely pass against this one.
 */
const LOCAL_KEY = "sentinel-local-9f2a";
const CLOUD_KEY = "sentinel-cloud-4b71";
const FLEET_DEFAULT_KEY = "sentinel-fleet-default-c0de";

function doc(over: { cloudBaseUrl?: string; cloudKeyEnv?: string } = {}): Record<string, unknown> {
  return {
    version: 2,
    name: "provider-credentials",
    docker: { pi_version: "0.79.6", network: "pifleet-cred" },
    run: { repo: "./repo", budget: { tokens_ceiling: 1_000_000 } },
    llm: {
      model: MODEL,
      provider: "omlx",
      providers: {
        omlx: { hosted: false, base_url: LOCAL_URL, api_key_env: "LOCAL_OMLX_KEY" },
        "ollama-cloud": {
          hosted: true,
          base_url: over.cloudBaseUrl ?? CLOUD_URL,
          api_key_env: over.cloudKeyEnv ?? "OLLAMA_CLOUD_KEY",
        },
      },
    },
    roles: { plain: {} },
    workers: [
      { id: "w-local", role: "plain" },
      { id: "w-cloud", role: "plain", model: `ollama-cloud/${MODEL}` },
    ],
    egress: { allow: [] },
  };
}

const load = (d: Record<string, unknown>): Promise<LoadedConfig> =>
  parseConfig(stringify(d), join(tmpdir(), "provider-credentials", "fleet.yaml"));

const HOST_ENV: Record<string, string | undefined> = {
  LOCAL_OMLX_KEY: LOCAL_KEY,
  OLLAMA_CLOUD_KEY: CLOUD_KEY,
  OMLX_API_KEY: FLEET_DEFAULT_KEY,
};

// ---------------------------------------------------------------------------
// ISC-425 — the WORKER's key is its provider's
// ---------------------------------------------------------------------------

describe("ISC-425: a worker carries its resolved provider's key, not the fleet's", () => {
  const planFor = async (id: string) => {
    const loaded = await load(doc());
    return buildWorkerEnv(loaded, resolveWorker(loaded, id), HOST_ENV);
  };

  test("each worker's key file is named and valued from its own provider block", async () => {
    const local = await planFor("w-local");
    const cloud = await planFor("w-cloud");

    expect(local.apiKeyEnvName).toBe("LOCAL_OMLX_KEY");
    expect(cloud.apiKeyEnvName).toBe("OLLAMA_CLOUD_KEY");
    expect(local.secretFiles).toEqual([{ name: "LOCAL_OMLX_KEY", value: LOCAL_KEY }]);
    expect(cloud.secretFiles).toEqual([{ name: "OLLAMA_CLOUD_KEY", value: CLOUD_KEY }]);

    // THE DISTINGUISHING ASSERTION. A fleet-wide read returns one name twice
    // and satisfies every "is a key delivered at all" check above it.
    expect(local.apiKeyEnvName).not.toBe(cloud.apiKeyEnvName);
  });

  /**
   * THE ANTI, and the one that actually fails against the pre-fix code.
   *
   * `OMLX_API_KEY` is `llm.api_key_env`'s schema default, so on a providers-map
   * fleet — where ISC-403 forbids writing the flat key at all — it is what the
   * old `llm.api_key_env` read resolved to. Its sentinel must reach NEITHER
   * worker, by name or by value, on any of the three surfaces a key travels on.
   */
  test("the fleet default's variable reaches no worker, by name or by value", async () => {
    for (const id of ["w-local", "w-cloud"]) {
      const plan = await planFor(id);
      const serialized = JSON.stringify(plan);
      expect(serialized).not.toContain(FLEET_DEFAULT_KEY);
      expect(plan.apiKeyEnvName).not.toBe("OMLX_API_KEY");
      expect(plan.secretFiles.map((f) => f.name)).not.toContain("OMLX_API_KEY");
    }
  });

  /**
   * The key is REDACTABLE under its own name too. `SECRET_NAMES_VAR` arms the
   * redactor by NAME, so a worker whose key is delivered as `OLLAMA_CLOUD_KEY`
   * while the redactor was armed with `OMLX_API_KEY` would log its own
   * credential in clear — the delivery half being right is not sufficient.
   */
  test("the redactor is armed with the provider's key name", async () => {
    const cloud = await planFor("w-cloud");
    const names = (cloud.vars["PIFLEET_SECRET_NAMES"] ?? "").split(",").filter(Boolean);
    expect(names).toContain("OLLAMA_CLOUD_KEY");
    expect(names).not.toContain("OMLX_API_KEY");
  });

  /**
   * A FLAT fleet is unchanged, and this is not a formality: §6.1 makes the flat
   * keys the default provider's own block, so reading `llm.api_key_env` there
   * is not an inheritance. Without this test the fix could be "always read the
   * map" and every pre-D7 fleet would lose its credential.
   */
  test("a flat fleet still reads llm.api_key_env", async () => {
    const flat = doc();
    flat["llm"] = { model: MODEL, base_url: LOCAL_URL, api_key_env: "FLAT_KEY" };
    flat["workers"] = [{ id: "w-local", role: "plain" }];
    const loaded = await load(flat);
    const plan = buildWorkerEnv(loaded, resolveWorker(loaded, "w-local"), {
      ...HOST_ENV,
      FLAT_KEY: "sentinel-flat-77",
    });
    expect(plan.apiKeyEnvName).toBe("FLAT_KEY");
    expect(plan.secretFiles).toEqual([{ name: "FLAT_KEY", value: "sentinel-flat-77" }]);
  });

  /**
   * NO FALLBACK, stated as a test because a `?? config.llm.api_key_env` is the
   * obvious "defensive" edit and it silently reintroduces the whole defect —
   * the result is a real variable name resolving to a real key.
   */
  test("an undeclared provider is refused rather than given the fleet default", async () => {
    const loaded = await load(doc());
    expect(() => providerApiKeyEnv(loaded.config, "never-declared")).toThrow(
      /will not fall back to llm\.api_key_env/,
    );
    // Anti-vacuity: the declared ones resolve, so the throw is about the
    // provider being absent and not about the resolver refusing everything.
    expect(providerApiKeyEnv(loaded.config, "ollama-cloud")).toBe("OLLAMA_CLOUD_KEY");
  });
});

// ---------------------------------------------------------------------------
// ISC-418 — the tool-call probe dials each provider at its own URL with its own key
// ---------------------------------------------------------------------------

const TOOL_CALL_BODY = {
  id: "chatcmpl-1",
  object: "chat.completion",
  model: MODEL,
  choices: [
    {
      index: 0,
      message: {
        role: "assistant",
        content: null,
        tool_calls: [
          { id: "call_1", type: "function", function: { name: "pifleet_probe", arguments: "{}" } },
        ],
      },
      finish_reason: "tool_calls",
    },
  ],
};

interface Dial {
  provider: string;
  url: string;
  auth: string | null;
}

/**
 * A transport FACTORY that records which provider each transport was built for
 * and what that transport was then asked to dial.
 *
 * Recording the factory argument separately from the request is what lets the
 * ISC-418 cases below tell "the right URL was dialed" apart from "the right
 * NETWORK would have carried it" — under D7 those are two different facts and
 * only one of them is visible in a URL.
 */
function recordingFactory(): { fetchFor: (p: string) => FetchLike; dials: Dial[]; built: string[] } {
  const dials: Dial[] = [];
  const built: string[] = [];
  const fetchFor = (provider: string): FetchLike => {
    built.push(provider);
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const headers = new Headers(init?.headers ?? {});
      dials.push({ provider, url: String(input), auth: headers.get("Authorization") });
      return new Response(JSON.stringify(TOOL_CALL_BODY), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as FetchLike;
  };
  return { fetchFor, dials, built };
}

describe("ISC-418: the tool-call probe is per provider", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const [k, v] of Object.entries(HOST_ENV)) {
      saved[k] = process.env[k];
      process.env[k] = v;
    }
  });
  afterEach(() => {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  test("both providers are probed even though they serve the SAME model id", async () => {
    const loaded = await load(doc());
    const { fetchFor, dials } = recordingFactory();
    await assertModelsSupportToolCalls(loaded, ["w-local", "w-cloud"], fetchFor);

    // TWO probes. De-duping on the model id alone yields one and certifies
    // whichever provider happened to be first.
    expect(dials).toHaveLength(2);
    expect(dials.map((d) => d.provider).sort()).toEqual(["ollama-cloud", "omlx"]);
  });

  test("each probe carries its own base_url and its own key", async () => {
    const loaded = await load(doc());
    const { fetchFor, dials } = recordingFactory();
    await assertModelsSupportToolCalls(loaded, ["w-local", "w-cloud"], fetchFor);

    const byProvider = new Map(dials.map((d) => [d.provider, d]));
    expect(byProvider.get("omlx")!.url).toBe(`${LOCAL_URL}/chat/completions`);
    expect(byProvider.get("ollama-cloud")!.url).toBe(`${CLOUD_URL}/chat/completions`);
    expect(byProvider.get("omlx")!.auth).toContain(LOCAL_KEY);
    expect(byProvider.get("ollama-cloud")!.auth).toContain(CLOUD_KEY);

    // THE ANTI. The fleet default's sentinel is a real value in `process.env`
    // throughout this test; a fleet-wide read would put it on both requests.
    for (const d of dials) expect(d.auth).not.toContain(FLEET_DEFAULT_KEY);
  });

  /**
   * THE CRITERION'S OWN MUTATION — "point one provider's `base_url` at the
   * other's and assert the refusal."
   *
   * Read as the discriminating question rather than transcribed: if the gate
   * read one fleet-wide `base_url`, moving the CLOUD provider's would change
   * nothing about what was dialed. So move it and require the dial to follow.
   * Same for the key.
   */
  test("moving one provider's base_url moves only that provider's dial", async () => {
    const moved = "https://moved.example.test/v2";
    const loaded = await load(doc({ cloudBaseUrl: moved, cloudKeyEnv: "LOCAL_OMLX_KEY" }));
    const { fetchFor, dials } = recordingFactory();
    await assertModelsSupportToolCalls(loaded, ["w-local", "w-cloud"], fetchFor);

    const byProvider = new Map(dials.map((d) => [d.provider, d]));
    expect(byProvider.get("ollama-cloud")!.url).toBe(`${moved}/chat/completions`);
    // The other provider is UNMOVED, which is what makes this per-provider
    // rather than merely "reads some provider's block".
    expect(byProvider.get("omlx")!.url).toBe(`${LOCAL_URL}/chat/completions`);
    // And the key followed the block too: this fixture deliberately points the
    // cloud block at the LOCAL variable, so the two dials now share a
    // credential — by configuration, not by a fleet-wide read.
    expect(byProvider.get("ollama-cloud")!.auth).toContain(LOCAL_KEY);
  });

  test("a transport is built for each provider, so each probe rides its own bridge", async () => {
    const loaded = await load(doc());
    const { fetchFor, built } = recordingFactory();
    await assertModelsSupportToolCalls(loaded, ["w-local", "w-cloud"], fetchFor);

    // The factory argument is the ONLY place the provider identity reaches the
    // transport — `up` turns it into `workerEgressNetwork(...)`, and a URL
    // cannot show which network carried it.
    expect(built.sort()).toEqual(["ollama-cloud", "omlx"]);
  });

  /**
   * The dedup that motivated keying by the pair is still doing its job: two
   * workers on the SAME provider and the SAME model probe once, not twice.
   * Without this, "key by the pair" could degrade to "never dedup" and cost a
   * real generation per worker on every `up`.
   */
  test("two workers on one provider and one model still probe once", async () => {
    const d = doc();
    d["workers"] = [
      { id: "w-local", role: "plain" },
      { id: "w-local-2", role: "plain" },
    ];
    const loaded = await load(d);
    const { fetchFor, dials } = recordingFactory();
    await assertModelsSupportToolCalls(loaded, ["w-local", "w-local-2"], fetchFor);
    expect(dials).toHaveLength(1);
  });
});
